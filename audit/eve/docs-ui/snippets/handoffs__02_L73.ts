// handoffs.md:73
import { createAgent, handoff, handoffFilters } from '@lousho/build-ai-agent';
import { z } from 'zod';

const refunds = createAgent({ name: 'refunds', description: 'Issues refunds', model: 'openai/gpt-4o-mini' });

const triage = createAgent({
  name: 'triage',
  model: 'openai/gpt-4o-mini',
  handoffs: [
    handoff(refunds, {
      toolName: 'escalate_refund',
      description: 'Hand off when the user asks for money back',
      input: z.object({ orderId: z.string() }),
      inputFilter: handoffFilters.removeToolCalls,
      onHandoff: ({ from, to, args }) => console.log(`${from} -> ${to}`, args),
      isEnabled: ({ metadata }) => metadata?.plan === 'pro',
    }),
  ],
});
export {};
