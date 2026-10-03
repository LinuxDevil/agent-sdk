/**
 * Live test for handoffs (N6): a triage agent hands a session to `billing`,
 * which hands back to triage for a question outside billing (openrouter/openai/gpt-4o-mini, `maxSteps: 6`).
 *
 * - Replay (default): each agent's model is served from its own cassette,
 *   `__fixtures__/cassettes/n6-handoffs-<agent>.json`, so the test costs nothing.
 * - Record: `LOUSHO_RECORD=1` with `OPENROUTER_API_KEY` set (at most 0.05 USD).
 *   Grep the cassettes for `sk-or-` and `Authorization` before committing them.
 *
 * Skipped when the cassettes are missing and no key is set.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from './createAgent';
import { handoff, type Handoff } from './handoffs';
import './providers'; // registers the real providers (openrouter)
import { resolveProvider } from './providers/resolveProvider';
import { recordReplay } from './testing';
import { defineTool } from './tools/defineTool';
import type { AgentEvent, HandoffEvent } from './execution/agentEvents';

const cassette = (agent: string) => path.join(__dirname, '__fixtures__', 'cassettes', `n6-handoffs-${agent}.json`);
const AGENTS = ['triage', 'billing', 'tech-support'];
const recording = Boolean(process.env.LOUSHO_RECORD);
const runnable = recording ? Boolean(process.env.OPENROUTER_API_KEY) : AGENTS.every((agent) => fs.existsSync(cassette(agent)));
const model = (agent: string) => recordReplay(() => resolveProvider('openrouter/openai/gpt-4o-mini'), { cassette: cassette(agent), mode: recording ? 'record' : 'replay' });

describe.skipIf(!runnable)('handoffs live (N6)', () => {
  it('triage hands a billing question to billing; billing hands an off-topic question back', async () => {
    const lookupCharges = defineTool({
      name: 'lookup_charges',
      description: "Lists the user's recent subscription charges",
      input: z.object({}),
      execute: async () => [{ date: '2026-09-01', amountUsd: 9.99 }, { date: '2026-09-01', amountUsd: 9.99 }],
    });
    const resetLink = defineTool({
      name: 'send_reset_link',
      description: 'Emails the user a password reset link',
      input: z.object({}),
      execute: async () => ({ sent: true }),
    });
    const billingHandoffs: Handoff[] = [];
    const billing = createAgent({
      name: 'billing',
      description: 'Handles charges, refunds and subscriptions',
      instructions: 'You are the billing desk. Check charges with lookup_charges and answer in one or two sentences. For anything that is not about billing, hand back to triage.',
      provider: model('billing'),
      tools: [lookupCharges],
      handoffs: billingHandoffs,
      maxSteps: 6,
    });
    const techSupport = createAgent({
      name: 'tech-support',
      description: 'Handles logins, passwords and technical problems',
      instructions: 'You are tech support. Use send_reset_link for password resets and answer in one or two sentences.',
      provider: model('tech-support'),
      tools: [resetLink],
      maxSteps: 6,
    });
    const events: AgentEvent[] = [];
    const triage = createAgent({
      name: 'triage',
      description: 'Routes the user to the right desk',
      instructions: 'You route the user. Hand billing questions to billing and technical questions (logins, passwords) to tech-support. Do not answer them yourself.',
      provider: model('triage'),
      handoffs: [billing, techSupport],
      maxSteps: 6,
      onEvent: (event) => events.push(event),
    });
    billingHandoffs.push(handoff(triage));
    const handoffs = () => events.filter((event): event is HandoffEvent => event.type === 'handoff').map(({ from, to }) => `${from}->${to}`);
    const session = triage.session();

    const first = await session.send('I was charged twice for my subscription.');
    expect(first.finishReason).toBe('stop');
    expect(first.agentName).toBe('billing');
    expect(handoffs()).toEqual(['triage->billing']);
    expect(first.text.length).toBeGreaterThan(0);

    events.length = 0;
    const second = await session.send('Thanks, and how do I reset my password?');
    expect(second.finishReason).toBe('stop');
    // Billing has no handoff to tech-support: it hands back to triage, which routes the question on.
    expect(handoffs()[0]).toBe('billing->triage');
    expect(handoffs()).not.toContain('billing->tech-support');
    expect(second.agentName).toBe('tech-support');
  });
});
