// handoffs.md:171
import { createAgent } from '@lousho/build-ai-agent';

const billing = createAgent({ name: 'billing', description: 'Handles charges and refunds', model: 'openai/gpt-4o-mini' });
const triage = createAgent({ name: 'triage', model: 'openai/gpt-4o-mini', handoffs: [billing] });

const session = triage.session();
await session.send('I was charged twice.'); // triage hands off; billing answers
const next = await session.send('Can you refund one?'); // billing answers again
console.log(next.agentName); // 'billing'
export {};
