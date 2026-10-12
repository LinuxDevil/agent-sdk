import { createAgent, defineTool, defineMemory, inMemoryMemory, allow } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
const toolMsgs = (r: any) => r.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content));
const send = defineTool({ name: 'send_email', description: 'Send', input: z.object({ to: z.string() }), needsApproval: true, execute: async ({ to }) => `sent to ${to}` });
// streamResolve sequence
let m = mockModel([{ toolCalls: [{ name: 'send_email', args: { to: 'sam' } }] }, 'Sent it.']);
let agent = createAgent({ provider: m, tools: [send] });
const ev1: string[] = [];
for await (const e of agent.stream('go')) ev1.push(e.type);
console.log('stream to pause:', ev1.join(' '));
const [p] = await agent.approvals.list();
const ev2: string[] = []; const run = agent.approvals.streamResolve({ id: p.id, approved: true });
for await (const e of run) ev2.push(e.type);
console.log('streamResolve:', ev2.join(' '), '| result', (await run.result).text);
// approve callback ignored by stream()
m = mockModel([{ toolCalls: [{ name: 'send_email', args: { to: 'sam' } }] }, 'Sent it.']);
agent = createAgent({ provider: m, tools: [send], approve: () => true });
const ev3: string[] = []; for await (const e of agent.stream('go')) ev3.push(e.type);
console.log('stream with approve cb ends:', ev3.slice(-2).join(' '));
// askQuestion
m = mockModel([{ toolCalls: [{ name: 'ask_question', args: { question: 'Where?', options: ['Lisbon', 'Porto'] } }] }, 'Booked.']);
agent = createAgent({ provider: m, askQuestion: true });
let r: any = await agent.send('Book me a weekend away');
const [q] = await agent.approvals.list();
console.log('question pending:', r.finishReason, q?.kind, JSON.stringify(q?.question));
r = await agent.approvals.answer({ id: r.approvalId, answer: 'lisbon' });
console.log('answer -> tool msg:', toolMsgs(r));
// allowFreeText false out-of-options
m = mockModel([{ toolCalls: [{ name: 'ask_question', args: { question: 'Where?', options: ['Lisbon', 'Porto'], allowFreeText: false } }] }, 'ok']);
agent = createAgent({ provider: m, askQuestion: true });
r = await agent.send('x'); r = await agent.approvals.answer({ id: r.approvalId, answer: 'Madrid' });
console.log('free text refused:', toolMsgs(r));
// decline
m = mockModel([{ toolCalls: [{ name: 'ask_question', args: { question: 'Where?' } }] }, 'ok']);
agent = createAgent({ provider: m, askQuestion: true });
r = await agent.send('x'); r = await agent.approvals.resolve({ id: r.approvalId, approved: false });
console.log('declined:', toolMsgs(r));
// allow rule on ask_question -> "No answer"
m = mockModel([{ toolCalls: [{ name: 'ask_question', args: { question: 'Where?' } }] }, 'ok']);
agent = createAgent({ provider: m, askQuestion: true, permissions: [allow('ask_question')] });
r = await agent.send('x'); console.log('allow ask_question:', r.finishReason, toolMsgs(r));
// scripted approve string answers question
m = mockModel([{ toolCalls: [{ name: 'ask_question', args: { question: 'Where?', options: ['Lisbon'] } }] }, 'ok']);
agent = createAgent({ provider: m, askQuestion: true, approve: (req: any) => (req.kind === 'question' ? 'Lisbon' : false) });
r = await agent.send('x'); console.log('scripted answer:', r.finishReason, toolMsgs(r));
// memory tools after resolve
const notes = defineMemory({ name: 'notes', scope: 'global', provider: inMemoryMemory() });
m = mockModel([{ toolCalls: [{ name: 'send_email', args: { to: 'sam' } }] }, 'Sent.']);
agent = createAgent({ provider: m, tools: [send], memory: [notes] });
r = await agent.send('go'); r = await agent.approvals.resolve({ id: r.approvalId, approved: true });
const names = (c: any) => (c.tools ?? []).map((t: any) => t.name ?? t.function?.name).join(',');
console.log('tools 1st call:', names(m.calls[0]), '| after resolve:', names(m.calls[1]), '| memory block after resolve:', String(m.calls[1].messages[0].content).includes('<memory'));
