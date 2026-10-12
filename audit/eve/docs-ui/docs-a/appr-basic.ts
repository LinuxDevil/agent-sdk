import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
const ran: string[] = [];
const mk = (name: string, needsApproval: any = false) => defineTool({ name, description: name, input: z.object({ v: z.string() }), needsApproval, execute: async ({ v }) => { ran.push(`${name}:${v}`); return `${name} ok ${v}`; } });
const tools = [mk('a'), mk('gated', true), mk('c')];
// batch ordering
let model = mockModel([{ toolCalls: [{ name: 'a', args: { v: '1' } }, { name: 'gated', args: { v: '2' } }, { name: 'c', args: { v: '3' } }] }, 'final']);
let agent = createAgent({ provider: model, tools });
const paused = await agent.send('go');
console.log('paused', paused.finishReason, paused.approvalId, 'ran before decision:', [...ran]);
const list = await agent.approvals.list();
console.log('list entry keys:', Object.keys(list[0]).sort().join(','), JSON.stringify(list[0]));
console.log('get(id):', !!(await agent.approvals.get(paused.approvalId!)), 'get(garbage):', await agent.approvals.get('../nope'));
const res = await agent.approvals.resolve({ id: paused.approvalId!, approved: false, note: 'not today' });
console.log('after reject ran:', ran, 'final:', res.finishReason, res.text);
const toolMsgs = res.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content));
console.log('tool msgs:', toolMsgs);
for (const id of [paused.approvalId!, 'unknown-id']) {
  const e: any = await agent.approvals.resolve({ id, approved: true }).catch((x) => x);
  console.log('resolve again/unknown:', id.slice(0, 10), e?.name, e?.code, String(e?.message).slice(0, 120));
}
