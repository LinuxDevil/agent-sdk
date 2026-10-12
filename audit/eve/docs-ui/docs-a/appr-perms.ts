import { allow, ask, deny, once, createAgent, defineTool, APPROVAL_EXPIRED_REASON } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
const ran: string[] = [];
const tool = (name: string, needsApproval?: any) => defineTool({ name, description: name, input: z.object({ command: z.string() }), ...(needsApproval !== undefined ? { needsApproval } : {}), execute: async ({ command }) => { ran.push(`${name}:${command}`); return `ran ${command}`; } });
const toolMsgs = (r: any) => r.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content));
// A: doc's rule list
const log: any[] = [];
let m = mockModel([{ toolCalls: [{ name: 'shell', args: { command: 'rm -rf /' } }, { name: 'read_x', args: { command: 'ls' } }, { name: 'shell', args: { command: 'ls' } }] }, 'end']);
let agent = createAgent({ provider: m, tools: [tool('shell'), tool('read_x', true)], permissions: [
  { tool: 'shell', when: (args: any) => /\brm\b/.test(String(args.command)), action: 'deny', reason: 'Deleting files is not allowed' },
  allow(/^read_/), deny('delete_file', 'Use the trash tool instead'), ask(['shell', 'write_file'])],
  onPermissionDecision: (e: any) => log.push(e) });
let r: any = await agent.send('go');
console.log('A finish', r.finishReason, 'ran', ran, '\n tool msgs', toolMsgs(r), '\n decisions', log.map((e) => `${e.toolName}:${e.decision}:${e.rule?.index}:${e.rule?.reason ?? ''}:${Object.keys(e).sort().join('|')}`));
// B: needsApproval deny beats allow rule
ran.length = 0;
m = mockModel([{ toolCalls: [{ name: 'd', args: { command: 'x' } }] }, 'end']);
agent = createAgent({ provider: m, tools: [tool('d', () => ({ deny: 'nope' }))], permissions: [allow('d')] });
r = await agent.send('go'); console.log('B (tool deny vs allow rule):', r.finishReason, ran, toolMsgs(r));
// C: once() in a session
ran.length = 0;
const askOnce = once();
m = mockModel([{ toolCalls: [{ name: 'deploy', args: { command: 'a' } }] }, 'one', { toolCalls: [{ name: 'deploy', args: { command: 'b' } }] }, 'two']);
agent = createAgent({ provider: m, tools: [tool('deploy', (a: any, c: any) => askOnce(a, c))] });
const s = agent.session();
r = await s.send('1'); console.log('C1', r.finishReason);
r = await agent.approvals.resolve({ id: r.approvalId, approved: true }); console.log('C1 resolved', r.finishReason, r.text);
r = await s.send('2'); console.log('C2 (should run without asking):', r.finishReason, r.text, ran);
// D: TTL expiry
ran.length = 0;
m = mockModel([{ toolCalls: [{ name: 'mail', args: { command: 'x' } }] }, 'after']);
agent = createAgent({ provider: m, tools: [tool('mail', true)], approvalTtlMs: 50 });
r = await agent.send('go'); const [p] = await agent.approvals.list(); console.log('D expiresAt', p.expiresAt, 'createdAt', p.createdAt);
await new Promise((res) => setTimeout(res, 120));
r = await agent.approvals.resolve({ id: r.approvalId, approved: true }); console.log('D expired+approved:', r.finishReason, 'ran', ran, toolMsgs(r), 'const', APPROVAL_EXPIRED_REASON);
// E: approve callback variants
for (const verdict of [true, false, 'defer', 'a string note'] as const) {
  ran.length = 0;
  m = mockModel([{ toolCalls: [{ name: 'g', args: { command: 'x' } }] }, 'fin']);
  agent = createAgent({ provider: m, tools: [tool('g', true)], approve: () => verdict as any });
  r = await agent.send('go');
  console.log('E approve=', verdict, '->', r.finishReason, 'ran', ran.length, 'pending', (await agent.approvals.list()).length, toolMsgs(r).map((x: string) => x.slice(0, 90)));
}
