/**
 * Live test (costs money, needs OPENROUTER_API_KEY; at most 0.05 USD): an agent on
 * `openrouter/openai/gpt-4o-mini` with one generator tool, `count_to({ n })`, that yields `{ at: i }`
 * per step and finally `{ done: true, n }` (N13b). Asserts the snapshots streamed as `tool.partial`
 * and the model's answer follows the final result. Records the model calls to
 * `__fixtures__/cassettes/n13b-tool-partial.json` for the replay test (toolPartial.replay.test.ts).
 * Run with `npm run test:live -- src/execution/toolPartial`.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';
import '../providers'; // registers the real providers (openrouter)
import { resolveProvider } from '../providers/resolveProvider';
import { recordReplay } from '../testing';
import { countToTool, PROMPT, runCounting } from './__fixtures__/toolPartialLive';

const CASSETTE = join(__dirname, '__fixtures__', 'cassettes', 'n13b-tool-partial.json');

describe.skipIf(!process.env.OPENROUTER_API_KEY)('generator tool on a real model (N13b)', () => {
  it('streams tool.partial snapshots; the model answers from the final result', async () => {
    const provider = recordReplay(() => resolveProvider('openrouter/openai/gpt-4o-mini'), { cassette: CASSETTE, mode: 'record' });
    const agent = createAgent({ provider, tools: [countToTool()], maxSteps: 3 });

    const { partials, done, result } = await runCounting(agent.stream(PROMPT));

    expect(partials.map((e) => e.output)).toEqual([{ at: 1 }, { at: 2 }, { done: true, n: 3 }]);
    expect(done?.result).toEqual({ done: true, n: 3 });
    expect(result.finishReason).toBe('stop');
    expect(result.text.toLowerCase()).toContain('done');
  }, 60_000);
});
