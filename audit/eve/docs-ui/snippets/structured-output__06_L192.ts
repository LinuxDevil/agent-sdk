// structured-output.md:192
import { z } from 'zod';
import { createAgent } from '@lousho/build-ai-agent';

const Invoice = z.object({ subtotal: z.number(), tax: z.number(), total: z.number() });
const agent = createAgent({ model: 'openai/gpt-4o-mini', output: Invoice });

const result = await agent.send('Extract the invoice: subtotal 100.00, tax 19.00, total 120.00');
const invoice = result.object;
if (invoice && Math.abs(invoice.subtotal + invoice.tax - invoice.total) > 0.005) {
  console.warn('Totals do not add up', invoice, result.outputRepaired ? '(after a repair)' : '');
}
export {};
