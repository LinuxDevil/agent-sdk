/**
 * Live test (costs money, needs OPENROUTER_API_KEY; at most 0.05 USD): `send()` with a listener on
 * `openrouter/openai/gpt-4o-mini` streams the model call, so the step's text arrives as several `text.delta`
 * events (M9). Records `__fixtures__/cassettes/send-streams.json` for a replay test. Run with
 * `npm run test:live -- src/execution/sendStreams`.
 */
import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';
import { resolveProvider } from '../providers/resolveProvider';
import { recordReplay } from '../testing';
import type { AgentEvent } from './agentEvents';

describe.skipIf(!process.env.OPENROUTER_API_KEY)('send() with a listener streams live (M9)', () => {
  it('delivers the reply as several text.delta events that add up to result.text', async () => {
    const provider = recordReplay(() => resolveProvider('openrouter/openai/gpt-4o-mini'), {
      cassette: 'src/execution/__fixtures__/cassettes/send-streams.json',
      mode: 'record',
    });
    const heard: AgentEvent[] = [];
    const agent = createAgent({ provider, maxSteps: 1, onEvent: (event) => heard.push(event) });

    const result = await agent.send('Count from 1 to 20, comma separated.');

    const deltas = heard.flatMap((event) => (event.type === 'text.delta' ? [event.text] : []));
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(result.text);
  });
});
