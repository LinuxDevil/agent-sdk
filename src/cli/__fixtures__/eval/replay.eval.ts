/**
 * Fixture for the `--record` / `--replay` / `--drift` tests in
 * src/cli/eval.test.ts (LOU-D46). The "real" provider is a mockModel set up
 * from env vars: FIXTURE_PROVIDER=offline makes every model call fail (so
 * replay provably never calls it) and FIXTURE_ORDER_ID changes the tool
 * arguments (drift). Its cassettes are written to __cassettes__/ next to this
 * file and deleted by the test.
 */
import { z } from 'zod';
import { createAgent } from '../../../createAgent';
import { defineEval } from '../../../evals';
import { defineTool } from '../../../tools/defineTool';
import { mockModel } from '../../../testing';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order',
  input: z.object({ orderId: z.string() }),
  execute: ({ orderId }) => ({ orderId, status: 'shipped' }),
});

const realProvider = () =>
  process.env.FIXTURE_PROVIDER === 'offline'
    ? mockModel([])
    : mockModel([
        { toolCalls: [{ name: 'lookup_order', args: { orderId: process.env.FIXTURE_ORDER_ID ?? '42' } }] },
        { text: 'Refunds are possible within 30 days.' },
      ]);

defineEval({
  name: 'recorded refund',
  agent: () => createAgent({ prompt: 'You handle refunds.', tools: [lookupOrder], provider: realProvider() }),
  cases: [{ input: 'Refund order 42', label: 'plain' }],
  async test(t, c) {
    await t.send(c.input);
    t.completed();
    t.calledTool('lookup_order');
  },
});
