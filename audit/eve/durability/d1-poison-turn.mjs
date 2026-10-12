// D1: in a checkpointed session, a turn whose follow-up model call fails
// deterministically (e.g. a tool returned a result that overflows the context
// window -> HTTP 400) leaves an 'in-progress' checkpoint. Every later send()
// first replays that poisoned turn, so the session is bricked until the caller
// discovers discardPending(). Without a store the same failure is harmless.
import { createAgent, memoryStore, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const overflow = Object.assign(new Error('400 context_length_exceeded: maximum context length is 128000 tokens'), { status: 400 });
const turn = (req) => {
  if (req.messages.some((m) => m.role === 'tool' && String(m.content).includes('HUGE'))) return { error: overflow };
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  if (String(lastUser.content).startsWith('A')) return { toolCalls: [{ name: 'dump_logs', args: {} }] };
  return `ok: ${lastUser.content}`;
};
const tools = [defineTool({ name: 'dump_logs', description: 'dump logs', input: z.object({}), execute: async () => 'HUGE'.repeat(10) })];
for (const durable of [false, true]) {
  const model = mockModel([turn], { onExhausted: 'repeat-last' });
  const agent = createAgent({ provider: model, tools, ...(durable ? { store: memoryStore() } : {}) });
  const s = agent.session({ id: 'chat' });
  try { await s.send('A: show me the logs'); } catch (e) { console.log(`[durable=${durable}] send A ->`, e.code ?? e.name); }
  for (const msg of ['B: never mind, say hi', 'C: hello?']) {
    try {
      const r = await s.send(msg);
      console.log(`[durable=${durable}] send ${msg[0]} ->`, r.finishReason, JSON.stringify(r.text));
    } catch (e) { console.log(`[durable=${durable}] send ${msg[0]} ->`, 'THREW', e.code ?? e.name, '-', e.message.slice(0, 70)); }
  }
  console.log(`  pending():`, JSON.stringify(await s.pending()), ' model calls:', model.calls.length);
}
