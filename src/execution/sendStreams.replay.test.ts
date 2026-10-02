/**
 * CI replay of the M9 live recording (`__fixtures__/cassettes/send-streams.json`, gpt-4o-mini via OpenRouter):
 * `send()` with a listener streams the model call, so the reply arrives as several `text.delta` events that add up
 * to `result.text`. No key, no network. Re-record with `npm run test:live -- src/execution/sendStreams`.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';
import { recordReplay } from '../testing';
import type { AgentEvent } from './agentEvents';

const CASSETTE = join(__dirname, '__fixtures__', 'cassettes', 'send-streams.json');

describe('send() with a listener streams, replayed from a real recording (M9)', () => {
  it('delivers the reply as several text.delta events that add up to result.text', async () => {
    const provider = recordReplay(undefined, { cassette: CASSETTE, mode: 'replay' });
    const heard: AgentEvent[] = [];
    const agent = createAgent({ provider, maxSteps: 1, onEvent: (event) => heard.push(event) });

    const result = await agent.send('Count from 1 to 20, comma separated.');

    const deltas = heard.flatMap((event) => (event.type === 'text.delta' ? [event.text] : []));
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(result.text);
  });
});
