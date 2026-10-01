/**
 * Fixture for src/cli/eval.test.ts: an eval that fails its gate assertion.
 */
import { createAgent } from '../../../createAgent';
import { defineEval } from '../../../evals';
import { mockModel } from '../../../testing';

defineEval({
  name: 'broken flow',
  agent: createAgent({ prompt: 'p', provider: mockModel(['I did nothing useful.']) }),
  async test(t) {
    await t.send('Refund order 42');
    t.calledTool('lookup_order');
  },
});
