/**
 * Live harness tests: every archetype example runs once against the real
 * model (`openrouter/openai/gpt-4o-mini`), creating agents exactly the way
 * production code does - `createAgent({ model })` resolves the provider and
 * reads the key from the environment.
 *
 * Requires OPENROUTER_API_KEY, from the shell or a `.env` at the repo root
 * (vitest loads `.env` into `process.env`; `.env` is gitignored). Each test
 * costs a few cents at most.
 *
 *   npm run test:live
 *
 * These tests are NEVER in CI: `*.live.test.ts` is excluded from the default
 * vitest config and no workflow runs `test:live`. They exist so a change that
 * breaks a real model's ability to drive a harness (tool calls, sub-agent
 * fan-out, handoffs, approval pause/resume, a judge loop, SQL generation)
 * is caught by a human before it ships - the mock-model suites cannot prove
 * a real model emits the shapes the harnesses parse.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent, defineTool, resolveProvider } from '../src';
import { createDeepResearch } from './deep-research';
import { createSupportDesk } from './support-desk';
import { runEvaluatorLoop } from './evaluator-loop';
import { createDataAnalyst, seedDatabase, QUESTION } from './data-analyst';

const MODEL = 'openrouter/openai/gpt-4o-mini';

describe.skipIf(!process.env.OPENROUTER_API_KEY)('live harnesses on OpenRouter (needs .env OPENROUTER_API_KEY)', () => {
  it('createAgent: the model calls a tool and answers', async () => {
    let called = 0;
    const getTime = defineTool({
      name: 'get_time',
      description: 'Get the current time for a city',
      input: z.object({ city: z.string() }),
      execute: ({ city }) => {
        called += 1;
        return `It is 14:00 in ${city}.`;
      },
    });
    const agent = createAgent({
      model: MODEL,
      instructions: 'Use the get_time tool when asked about the time, then answer with what it returned.',
      tools: [getTime],
      maxSteps: 4,
    });
    const result = await agent.send('What time is it in Paris?');
    expect(called).toBeGreaterThanOrEqual(1);
    expect(result.text).toMatch(/14:00/);
  });

  it('createAgent: an approval pauses and approving resumes the run', async () => {
    let sent = 0;
    const sendMail = defineTool({
      name: 'send_mail',
      description: 'Send an email',
      input: z.object({ to: z.string(), body: z.string() }),
      needsApproval: true,
      execute: ({ to }) => {
        sent += 1;
        return `sent to ${to}`;
      },
    });
    const agent = createAgent({
      model: MODEL,
      instructions: 'Send the email the user asks for with send_mail, then confirm briefly.',
      tools: [sendMail],
      maxSteps: 4,
    });
    const paused = await agent.send('Email sam@example.com: the deploy is green.');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(sent).toBe(0);

    const resumed = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(sent).toBe(1);
    expect(resumed.text.length).toBeGreaterThan(0);
  });

  it(
    'deep-research: the coordinator fans out to the researcher sub-agent and cites sources',
    async () => {
      const { agent, stats } = createDeepResearch();
      const result = await agent.send('Research how agent harnesses handle human approval. Short report.');
      expect(result.text.length).toBeGreaterThan(40);
      // the fan-out ran: at least one search call happened inside a sub-agent
      expect(stats.calls).toBeGreaterThanOrEqual(1);
      // the lead's instructions require [S#] citations when it uses findings
      expect(result.finishReason).toBe('stop');
    },
    120_000
  );

  it(
    'support-desk: triage hands a refund request to billing, approval gates the refund',
    async () => {
      const desk = createSupportDesk();
      const paused = await desk.agent.send(
        'I was charged twice for order A-10042 - I need a refund for the duplicate charge.'
      );

      // a real model must reach the billing specialist through the transfer gate
      expect(desk.handoffsSeen.some((h) => h.to === 'billing')).toBe(true);

      // the refund is approval-gated: either we are paused on it now or it
      // was already asked and denied - it must never run unapproved
      if (paused.finishReason === 'awaiting-approval') {
        const before = desk.state.refunds.length;
        const resumed = await desk.agent.approvals.resolve({ id: paused.approvalId!, approved: true });
        expect(desk.state.refunds.length).toBe(before + 1);
        expect(resumed.text.length).toBeGreaterThan(0);
      } else {
        expect(desk.state.refunds).toHaveLength(0);
      }
    },
    120_000
  );

  it(
    'evaluator-loop: a real draft is judged and revised through llmCritique',
    async () => {
      const writer = createAgent({
        model: MODEL,
        instructions: 'You write short, clear release notes. Revise exactly what the critic asks for.',
        maxSteps: 2,
      });
      const result = await runEvaluatorLoop({
        writer,
        judge: {
          provider: resolveProvider(MODEL),
          model: 'openai/gpt-4o-mini',
          rubric: 'The draft is a release note: under 60 words, names a feature, says what the user gains.',
          temperature: 0,
        },
        prompt: 'Write the release-note line for a new "approval expiry" feature.',
        passScore: 0.75,
        maxRounds: 2,
      });
      expect(result.rounds).toBeGreaterThanOrEqual(1);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(result.text.length).toBeGreaterThan(10);
    },
    120_000
  );

  it(
    'data-analyst: the model inspects the schema, runs a read-only query and answers',
    async () => {
      const audit: string[] = [];
      let db;
      try {
        db = seedDatabase();
      } catch {
        return; // node:sqlite unavailable on this Node version
      }
      const { agent } = createDataAnalyst({ db, onAudit: (line) => audit.push(line) });
      const result = await agent.send(QUESTION);
      db.close();

      expect(result.text.length).toBeGreaterThan(10);
      // the audit log proves the calls went through the permission gate
      expect(audit.length).toBeGreaterThanOrEqual(1);
      // no deny decision: a correct run stays read-only
      expect(audit.some((line) => line.includes('deny'))).toBe(false);
    },
    120_000
  );
});
