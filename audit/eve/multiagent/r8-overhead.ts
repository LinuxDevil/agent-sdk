/* Eve multiagent repro 8: fixed per-request token overhead of `subagents` - the task tool plus the
 * three background tools are always registered (no way to opt out), on every lead model call.
 * Run: npx tsx eve/multiagent/r8-overhead.ts */
import { createAgent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

async function measure(withSubs: boolean) {
  const m = mockModel(['ok']);
  const worker = createAgent({ provider: mockModel(['x']), instructions: 'w', description: 'Summarizes a document' });
  const agent = createAgent({ provider: m, instructions: 'You are helpful.', ...(withSubs ? { subagents: { worker } } : {}) });
  await agent.send('hi');
  const req: any = m.calls[0];
  const sys = String(req.messages.find((x: any) => x.role === 'system')?.content ?? '');
  const tools = JSON.stringify(req.tools ?? []);
  return { sys: sys.length, tools: tools.length, names: (req.tools ?? []).map((t: any) => t.name ?? t.function?.name) };
}
const a = await measure(false), b = await measure(true);
console.log('without subagents:', a);
console.log('with 1 subagent:   ', b);
console.log(`added per lead request: ~${b.sys - a.sys + b.tools - a.tools} chars (~${Math.round((b.sys - a.sys + b.tools - a.tools) / 4)} tokens)`);
