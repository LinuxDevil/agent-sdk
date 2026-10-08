/**
 * Fixture for src/cli/eval.test.ts: a case that outlives its `timeoutMs`, so
 * vitest fails it with a timeout before the case can report a result.
 */
import { createAgent } from '../../../createAgent';
import { defineEval } from '../../../evals';
import { mockModel } from '../../../testing';

defineEval({
  name: 'slow flow',
  agent: createAgent({ prompt: 'p', provider: mockModel(['done']) }),
  timeoutMs: 200,
  async test(t) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await t.send('hi');
    t.completed();
  },
});
