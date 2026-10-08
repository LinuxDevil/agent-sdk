/**
 * Repro: per-customer memory is lost for the rest of a session once triage
 * hands off: the specialist runs every later turn, and neither the lead's
 * memory slots nor the specialist's own are recalled or offered.
 *
 *   npx tsx support-desk/repro/memory-after-handoff.ts
 */
import { createAgent, defineMemory, inMemoryMemory } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const provider = inMemoryMemory();
await provider.add('customer:C100', { text: 'Shoe size EU 42; prefers email.' });
const notes = (name: string) => defineMemory({ name, scope: ({ principal }) => (principal ? `customer:${principal.id}` : undefined), provider });

const model = mockModel([
  'Hi Alice!', // turn 1: triage answers itself
  { toolCalls: [{ name: 'transfer_to_orders', args: { reason: 'order status' } }] }, 'Your order shipped.', // turn 2: handoff
  'I do not know your shoe size.', // turn 3: orders runs
]);
const orders = createAgent({ name: 'orders', description: 'orders', instructions: 'Orders desk.', provider: model, memory: [notes('orders_notes')] });
const triage = createAgent({ name: 'triage', instructions: 'Front desk.', provider: model, handoffs: [orders], memory: [notes('customer_notes')] });
const session = triage.session({ id: 's1' });
const principal = { id: 'C100', type: 'user' as const, authenticator: 'custom' };
await session.send('hello', { principal });
await session.send('where is my order?', { principal });
await session.send('what is my shoe size?', { principal });
model.calls.forEach((c, i) => {
  const sys = String(c.messages[0]?.content ?? '');
  console.log(`call ${i}: memory block in system prompt=${/<memory/.test(sys)} | tools=${(c.tools ?? []).map((t) => t.function.name).join(',')}`);
});
