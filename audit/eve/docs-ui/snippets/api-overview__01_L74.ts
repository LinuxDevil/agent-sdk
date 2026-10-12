// api-overview.md:74
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const refund = defineTool({ name: 'refund', description: 'Refunds an order', input: z.object({ orderId: z.string() }), execute: async () => 'ok' });

const agent = createAgent({
  provider: mockModel(['Hello!']),
  // A cheaper model for short inputs, tenant instructions, tools by role.
  model: ({ input }) => (typeof input === 'string' && input.length < 200 ? 'small-model' : 'large-model'),
  instructions: ({ metadata }) => `You are the support agent of ${String(metadata?.tenant ?? 'Acme')}.`,
  tools: ({ metadata }) => (metadata?.role === 'admin' ? [refund] : []),
});

await agent.send('Hi', { metadata: { tenant: 'Globex', role: 'admin' } });
export {};
