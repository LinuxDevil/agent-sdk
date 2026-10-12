// CORE: deterministic - aborting a session turn drops the user's message (and the tool call that already ran).
// Run: npx tsx eve/core/r17-session-abort-transcript.ts
import { z } from 'zod';
import { createAgent, defineTool, memoryStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
let charged = 0;
const charge = defineTool({ name: 'charge_card', description: 'charge', input: z.object({ amount: z.number() }), execute: async ({ amount }) => { charged += amount; return 'charged'; } });
const slow = defineTool({ name: 'slow', description: 's', input: z.object({}), execute: async (_a, ctx) => new Promise((res) => ctx.abortSignal?.addEventListener('abort', () => res('cancelled'))) });
const model = mockModel([
  'Hi Ali.',
  { toolCalls: [{ name: 'charge_card', args: { amount: 50 } }] },
  { toolCalls: [{ name: 'slow' }] },
  (req) => `I see ${req.messages.filter((m) => m.role === 'user').length} user msgs; tool msgs=${req.messages.filter((m) => m.role === 'tool').length}`,
]);
const agent = createAgent({ provider: model, store: memoryStore(), tools: [charge, slow] });
const s = agent.session({ id: 'abort-demo' });
await s.send('My name is Ali.');
const ac = new AbortController();
setTimeout(() => ac.abort(), 100);
const r2 = await s.send('Charge my card $50 then do the slow thing.', { signal: ac.signal });
console.log('turn 2 finishReason=%s charged=$%d', r2.finishReason, charged);
console.log('transcript after abort: %j', (await s.load()).map((m: any) => `${m.role}:${String(m.content ?? '').slice(0, 30)}${m.toolCalls ? `[calls ${m.toolCalls.map((c: any) => c.function.name)}]` : ''}`));
const r3 = await s.send('Did you charge me?');
console.log('turn 3 model view: %j', r3.text);
