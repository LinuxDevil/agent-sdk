/**
 * Live test (costs money, needs OPENROUTER_API_KEY; at most 0.05 USD): a streamed run on
 * `openrouter/openai/gpt-4o-mini` with `moderationGuardrail({ runInParallel: true })` (N5b), on a clean
 * input (passes, the text arrives) and on a moderation hit (the agent's call is aborted, no text), plus
 * one unrecorded blocking run of the clean input to compare the time to the first released `text.delta`.
 * Records the agent's calls and the guardrail's calls to two cassettes,
 * `__fixtures__/cassettes/n5b-parallel-guardrails-{agent,guardrail}.json`, for the replay test.
 * Run with `npm run test:live -- src/execution/parallelGuardrails`.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';
import '../providers'; // registers the real providers (openrouter)
import type { LLMProvider } from '../providers';
import { resolveProvider } from '../providers/resolveProvider';
import { recordReplay } from '../testing';
import { moderationGuardrail } from './guardrailStarterSet';

const MODEL = 'openrouter/openai/gpt-4o-mini';
const CASSETTES = join(__dirname, '__fixtures__', 'cassettes');
const CLEAN = 'Name three colors of the rainbow, comma separated.';
const HIT = 'I will hurt you badly if you come to my house again.';

/** Runs `input` streamed; the time from start to the first `text.delta`, the text and the result. */
async function timedRun(agentModel: LLMProvider, judge: LLMProvider, runInParallel: boolean, input: string) {
  const agent = createAgent({ provider: agentModel, maxSteps: 1, guardrails: { input: [moderationGuardrail({ model: judge, runInParallel })] } });
  const started = performance.now();
  let firstDeltaMs: number | undefined;
  let text = '';
  const run = agent.stream(input);
  for await (const event of run) {
    if (event.type !== 'text.delta') continue;
    firstDeltaMs ??= performance.now() - started;
    text += event.text;
  }
  return { firstDeltaMs, text, result: await run.result };
}

describe.skipIf(!process.env.OPENROUTER_API_KEY)('parallel input guardrails on a real model (N5b)', () => {
  it('a clean input streams; a moderation hit aborts the call with no text; blocking vs parallel latency', async () => {
    const agentModel = recordReplay(() => resolveProvider(MODEL), { cassette: join(CASSETTES, 'n5b-parallel-guardrails-agent.json'), mode: 'record' });
    const judge = recordReplay(() => resolveProvider(MODEL), { cassette: join(CASSETTES, 'n5b-parallel-guardrails-guardrail.json'), mode: 'record' });

    // Not recorded, and first (so it, not the parallel run, pays for the cold connection): the clean input
    // with the check blocking, for the latency comparison.
    const blocking = await timedRun(resolveProvider(MODEL), resolveProvider(MODEL), false, CLEAN);
    expect(blocking.result.finishReason).toBe('stop');

    const parallel = await timedRun(agentModel, judge, true, CLEAN);
    expect(parallel.result.finishReason).toBe('stop');
    expect(parallel.text).toBe(parallel.result.text);
    expect(parallel.text.length).toBeGreaterThan(0);

    const hit = await timedRun(agentModel, judge, true, HIT);
    expect(hit.result).toMatchObject({ finishReason: 'guardrail', text: '', guardrail: { name: 'moderation', kind: 'input' } });
    expect(hit.text).toBe('');

    console.log(
      `N5b time to first released text.delta: blocking ${Math.round(blocking.firstDeltaMs ?? -1)} ms, parallel ${Math.round(parallel.firstDeltaMs ?? -1)} ms`
    );
  }, 60_000);
});
