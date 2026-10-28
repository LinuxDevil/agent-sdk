/**
 * Fixture for the `defineEval({ dataset })` tests in src/cli/eval.test.ts:
 * the cases come from the stub daemon the test points LOUSHO_OBSERVE at.
 */
import { createAgent } from '../../../createAgent';
import { defineEval, equals } from '../../../evals';
import { mockModel } from '../../../testing';

defineEval({
  name: 'dataset refunds',
  dataset: 'refunds',
  agent: () => createAgent({ provider: mockModel([(req) => `echo ${String(req.messages.at(-1)?.content)}`]) }),
  async test(t, c) {
    await t.send(String(c.input));
    t.check('echoes', t.reply, equals(c.expected));
  },
});
