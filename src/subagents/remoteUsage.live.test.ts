/**
 * Live test (costs money, needs OPENROUTER_API_KEY; at most 0.03 USD): a lead on `mockModel` delegates once to a
 * remote agent served by the in-process `/chat` routes, whose model is `openrouter/openai/gpt-4o-mini`. Checks that
 * the lead's `result.usage` is its own plus what the remote reported on `run.done` (M10b). Run with
 * `npm run test:live -- src/subagents`.
 */
import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';
import type { AgentEventUsage } from '../execution/agentEvents';
import { serveFetch } from '../server/fetchRoutes';
import { mockModel } from '../testing';
import { remoteAgent } from './remoteAgent';

describe.skipIf(!process.env.OPENROUTER_API_KEY)('remote sub-agent usage live (M10b)', () => {
  it("adds the real remote run's reported usage to the lead's totals", async () => {
    const remoteAgentConfig = createAgent({ model: 'openrouter/openai/gpt-4o-mini', instructions: 'Answer in at most five words.', maxSteps: 1 });
    const reported: AgentEventUsage[] = [];
    const fetchRemote: typeof fetch = async (input, init) => {
      const response = await serveFetch(new Request(input as string, init), { name: 'remote', agent: () => remoteAgentConfig });
      const body = await response.text();
      for (const frame of body.split('\n\n')) {
        const event = frame.startsWith('data: ') ? (JSON.parse(frame.slice(6)) as { type: string; usage?: AgentEventUsage }) : undefined;
        if (event?.type === 'run.done' && event.usage) reported.push(event.usage);
      }
      return new Response(body, { status: response.status, headers: response.headers });
    };
    const leadModel = mockModel([
      { toolCalls: [{ name: 'task', args: { agent: 'remote', prompt: 'Name the capital of France.', description: 'capital' } }], usage: { inputTokens: 10, outputTokens: 1 } },
      { text: 'done', usage: { inputTokens: 20, outputTokens: 2 } },
    ]);
    const lead = createAgent({ provider: leadModel, instructions: 'lead', subagents: { remote: remoteAgent({ url: 'https://remote.test', fetch: fetchRemote, description: 'Answers questions' }) } });

    const { usage } = await lead.send('go');

    expect(reported).toHaveLength(1);
    const [remote] = reported;
    expect(remote.inputTokens).toBeGreaterThan(0);
    expect(usage.inputTokens).toBeGreaterThan(30);
    expect(usage.inputTokens).toBe(30 + remote.inputTokens);
    expect(usage.outputTokens).toBe(3 + remote.outputTokens);
    expect(usage.byModel['remote:remote']).toMatchObject({ inputTokens: remote.inputTokens, outputTokens: remote.outputTokens });
  });
});
