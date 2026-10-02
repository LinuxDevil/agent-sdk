/**
 * Fixture for src/cli/eval.test.ts: a tiny trajectory eval on a mockModel
 * agent. Run through `lousho eval` by the test, never by the default vitest
 * run (excluded in vitest.config.ts).
 */
import { z } from 'zod';
import { createAgent } from '../../../createAgent';
import { atLeast, defineEval, includes } from '../../../evals';
import { defineTool } from '../../../tools/defineTool';
import { mockModel } from '../../../testing';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order',
  input: z.object({ orderId: z.string() }),
  execute: ({ orderId }) => ({ orderId, status: 'shipped' }),
});

const makeAgent = () =>
  createAgent({
    prompt: 'You handle refunds.',
    tools: [lookupOrder],
    provider: mockModel([
      { toolCalls: [{ name: 'lookup_order', args: { orderId: '42' } }] },
      { text: 'Refunds are possible within 30 days.' },
    ]),
  });

defineEval({
  name: 'refund flow',
  tags: ['smoke'],
  agent: makeAgent,
  cases: [{ input: 'Refund order 42' }, { input: 'Please refund order 42', label: 'polite' }],
  async test(t, c) {
    await t.send(c.input);
    t.completed();
    t.calledTool('lookup_order', { args: { orderId: '42' } });
    t.check('mentions policy', t.reply, includes('30 days'));
    t.soft('brevity', 0.5, atLeast(0.9));
  },
});

defineEval({
  name: 'nightly only',
  tags: ['nightly'],
  agent: makeAgent,
  async test(t) {
    await t.send('hi');
    t.completed();
  },
});
