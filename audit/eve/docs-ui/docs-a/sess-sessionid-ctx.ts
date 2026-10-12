// tools.md:97 ctx.sessionId = "agent.session({ id })'s id"; memory.md:65 'session' scope key = 'session:<the agent.session({ id }) id>'
import { createAgent, defineTool, defineMemory, inMemoryMemory, memoryStore, memoryKey } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
for (const durable of [false, true]) {
  const seen: Record<string, unknown> = {};
  const t = defineTool({ name: 'probe', description: 'd', input: z.object({}), needsApproval: (_a, ctx: any) => { seen.needsApproval = ctx.sessionId; return false; }, execute: async (_a, ctx) => { seen.execute = ctx.sessionId; return 'ok'; } });
  const mem = inMemoryMemory();
  const slot = defineMemory({ name: 'prefs', scope: 'session', provider: mem });
  const scopeFn = defineMemory({ name: 'fn', scope: (c: any) => { seen.memoryScopeFn = c.sessionId; return 'x'; }, provider: inMemoryMemory() });
  const m = mockModel([{ toolCalls: [{ name: 'probe', args: {} }, { name: 'remember_prefs', args: { text: 'likes tea' } }] }, 'done']);
  const agent = createAgent({ provider: m, tools: [t], memory: [slot, scopeFn], permissions: [{ tool: 'probe', when: (_a: any, c: any) => { seen.permissionWhen = c.sessionId; return false; }, action: 'deny' }],
    instructions: (c: any) => { seen.instructionsCtx = c.sessionId; return 'sys'; }, ...(durable ? { store: memoryStore() } : {}) });
  await agent.session({ id: 'user-42' }).send('hi');
  // which key did memory write to?
  const keys = [memoryKey(slot, { sessionId: 'user-42' } as any)!, memoryKey(slot, { sessionId: 'user-42.turn-0' } as any)!];
  const where: Record<string, number> = {}; for (const k of keys) where[k] = (await mem.list(k)).length;
  console.log(durable ? 'DURABLE' : 'plain  ', JSON.stringify(seen), '| memory items by key:', JSON.stringify(where));
}
