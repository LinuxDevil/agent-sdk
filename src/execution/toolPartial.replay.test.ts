/**
 * CI replay of the N13b live recording (gpt-4o-mini via OpenRouter, `__fixtures__/cassettes/n13b-tool-partial.json`):
 * the model calls the generator tool `count_to({ n: 3 })`, its snapshots stream as `tool.partial`, and
 * the model answers from the final result. Replayed with `match: 'request'`, so the run must send the
 * recorded requests exactly: the second one carries only the final result, no snapshot. No key, no
 * network. Re-record with `npm run test:live -- src/execution/toolPartial`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';
import { recordReplay } from '../testing';
import { countToTool, PROMPT, runCounting } from './__fixtures__/toolPartialLive';

const CASSETTE = join(__dirname, '__fixtures__', 'cassettes', 'n13b-tool-partial.json');

describe.skipIf(!existsSync(CASSETTE))('generator tool, replayed from a real recording (N13b)', () => {
  it('streams tool.partial snapshots; the model answers from the final result', async () => {
    const provider = recordReplay(undefined, { cassette: CASSETTE, mode: 'replay', match: 'request' });
    const agent = createAgent({ provider, tools: [countToTool()], maxSteps: 3 });

    const { partials, done, result } = await runCounting(agent.stream(PROMPT));

    expect(partials.map((e) => [e.index, e.output])).toEqual([
      [0, { at: 1 }],
      [1, { at: 2 }],
      [2, { done: true, n: 3 }],
    ]);
    expect(done?.result).toEqual({ done: true, n: 3 });
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('Counting to 3 is done.');
    const toolMessages = result.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(toolMessages).toEqual([JSON.stringify({ done: true, n: 3 })]);
  });
});
