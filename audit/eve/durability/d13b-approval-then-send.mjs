// D13b: the realistic path - an app keeps one session object per user, the
// turn pauses for approval, a reviewer approves via agent.approvals.resolve()
// (which commits through its own session object), then the user sends again
// on the app's object.
import { createAgent, defineTool, memoryStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const tools = [defineTool({ name: 'refund', description: 'refund', input: z.object({}), needsApproval: true, execute: async () => 'refunded' })];
const model = mockModel([(r) => r.messages.at(-1).role === 'tool' ? 'Refund done.' : String(r.messages.at(-1).content).includes('refund') ? { toolCalls: [{ name: 'refund', args: {} }] } : 'Anything else?'], { onExhausted: 'repeat-last' });
const agent = createAgent({ provider: model, tools, store: memoryStore() });
const sessions = new Map();
const sessionFor = (id) => sessions.get(id) ?? sessions.set(id, agent.session({ id })).get(id);

const paused = await sessionFor('cust-1').send('please refund order 9');
console.log('turn 1:', paused.finishReason);
const resolved = await agent.approvals.resolve({ id: paused.approvalId, approved: true });
console.log('reviewer approves ->', resolved.finishReason, JSON.stringify(resolved.text));
try {
  const r = await sessionFor('cust-1').send('thanks!');
  console.log('user sends again ->', r.finishReason, '  PASS');
} catch (e) { console.log('user sends again ->', e.code, '  FAIL: cached session object is permanently stale after an approval'); }
