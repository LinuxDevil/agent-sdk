// handoffs.md:239
import { createAgent } from '@lousho/build-ai-agent';

const billing = createAgent({ name: 'billing', description: 'Handles charges and refunds', model: 'openai/gpt-4o-mini' });
const triage = createAgent({ name: 'triage', model: 'openai/gpt-4o-mini', handoffs: [billing] });

for await (const event of triage.stream('I was charged twice.')) {
  if (event.type === 'handoff') console.log(`${event.from} -> ${event.to}`); // triage -> billing
}
export {};
