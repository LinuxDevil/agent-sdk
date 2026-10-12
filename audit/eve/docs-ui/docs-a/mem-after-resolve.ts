// memory.md:209-211 claims: after agent.approvals.resolve(), "the recalled block stays in the prompt but the memory tools are not offered"
import { createAgent, defineTool, defineMemory, inMemoryMemory, memoryKey, memoryStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
const send = defineTool({ name: 'send_email', description: 'Send', input: z.object({ to: z.string() }), needsApproval: true, execute: async ({ to }) => `sent to ${to}` });
const prov = inMemoryMemory();
const notes = defineMemory({ name: 'notes', scope: 'global', provider: prov });
await prov.add(memoryKey(notes)!, { text: 'User prefers French.' });
for (const mode of ['send', 'session', 'durable-session'] as const) {
  const m = mockModel([{ toolCalls: [{ name: 'send_email', args: { to: 'sam' } }] }, 'Sent.']);
  const agent = createAgent({ provider: m, tools: [send], memory: [notes], ...(mode === 'durable-session' ? { store: memoryStore() } : {}) });
  let r: any = mode === 'send' ? await agent.send('go') : await agent.session({ id: 'm-' + mode }).send('go');
  r = await agent.approvals.resolve({ id: r.approvalId, approved: true });
  const sys = (c: any) => c.messages.filter((x: any) => x.role === 'system').map((x: any) => String(x.content)).join('\n');
  const tools = (c: any) => (c.tools ?? []).map((t: any) => t.name ?? t.function?.name).join(',');
  console.log(`[${mode}] call1 block:`, sys(m.calls[0]).includes('User prefers French.'), 'tools:', tools(m.calls[0]), '|| call2 (after resolve) block:', sys(m.calls[1]).includes('User prefers French.'), 'tools:', tools(m.calls[1]), '| roles:', m.calls[1].messages.map((x: any) => x.role).join(','));
}
