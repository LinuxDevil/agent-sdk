import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
const refund = defineTool({ name: 'refund', description: 'Refunds an order', input: z.object({ orderId: z.string() }), execute: async () => 'ok' });
const model = mockModel(['Hello!', 'Hello again', 'x', 'y']);
const seen: any[] = [];
const agent = createAgent({
  provider: model,
  model: (ctx) => { seen.push(ctx); return typeof ctx.input === 'string' && ctx.input.length < 200 ? 'small-model' : 'large-model'; },
  instructions: ({ metadata }) => `You are the support agent of ${String(metadata?.tenant ?? 'Acme')}.`,
  tools: ({ metadata }) => (metadata?.role === 'admin' ? [refund] : []),
});
await agent.send('Hi', { metadata: { tenant: 'Globex', role: 'admin' } });
const c: any = model.calls[0];
console.log('model sent:', c.model, '| system:', JSON.stringify(c.messages[0].content).slice(0, 80), '| tools:', (c.tools ?? []).map((t: any) => t.name ?? t.function?.name));
await agent.send('Hi', { metadata: { tenant: 'Initech', role: 'user' } });
const c2: any = model.calls[1];
console.log('2nd model:', c2.model, '| tools:', (c2.tools ?? []).map((t: any) => t.name ?? t.function?.name));
// session: runs again every turn?
const s = agent.session({ id: 'dyn1' });
await s.send('turn one', { metadata: { role: 'admin' } } as any);
await s.send('x'.repeat(250));
console.log('ctx seen:', seen.map((x) => ({ sid: x.sessionId, inLen: typeof x.input === 'string' ? x.input.length : JSON.stringify(x.input).slice(0, 40), md: x.metadata })));
console.log('session models:', (model.calls as any[]).slice(2).map((c) => c.model));
// throwing resolver
const bad = createAgent({ provider: mockModel(['a']), instructions: () => { throw new Error('boom'); } });
const e: any = await bad.send('hi').catch((x) => x);
console.log('throwing resolver:', e?.code, e?.field, e?.cause?.message);
