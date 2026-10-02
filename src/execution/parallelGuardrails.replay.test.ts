/**
 * CI replay of the N5b live recording (gpt-4o-mini via OpenRouter): a streamed run with
 * `moderationGuardrail({ runInParallel: true })` on a clean input (passes, the text arrives) and on a
 * moderation hit (blocked, no text). The agent's calls and the guardrail's calls are in two cassettes,
 * `__fixtures__/cassettes/n5b-parallel-guardrails-{agent,guardrail}.json`; in the recording the hit's agent
 * call was aborted by the trip. No key, no network. Re-record with
 * `npm run test:live -- src/execution/parallelGuardrails`.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';
import { recordReplay } from '../testing';
import { moderationGuardrail } from './guardrailStarterSet';

const CASSETTES = join(__dirname, '__fixtures__', 'cassettes');
const CLEAN = 'Name three colors of the rainbow, comma separated.';
const HIT = 'I will hurt you badly if you come to my house again.';

async function streamed(input: string) {
  const agentModel = recordReplay(undefined, { cassette: join(CASSETTES, 'n5b-parallel-guardrails-agent.json'), mode: 'replay', match: 'request' });
  const judge = recordReplay(undefined, { cassette: join(CASSETTES, 'n5b-parallel-guardrails-guardrail.json'), mode: 'replay', match: 'request' });
  const agent = createAgent({ provider: agentModel, maxSteps: 1, guardrails: { input: [moderationGuardrail({ model: judge, runInParallel: true })] } });
  const run = agent.stream(input);
  let text = '';
  for await (const event of run) if (event.type === 'text.delta') text += event.text;
  return { text, result: await run.result };
}

describe('parallel input guardrails, replayed from a real recording (N5b)', () => {
  it('a clean input passes and its streamed text arrives', async () => {
    const { text, result } = await streamed(CLEAN);
    expect(result.finishReason).toBe('stop');
    expect(text).toBe('Red, green, blue.');
    expect(result.text).toBe(text);
  });

  it('a moderation hit blocks the run with no text', async () => {
    const { text, result } = await streamed(HIT);
    expect(text).toBe('');
    expect(result).toMatchObject({
      finishReason: 'guardrail',
      text: '',
      guardrail: { name: 'moderation', kind: 'input', info: { category: 'moderation' } },
    });
  });
});
