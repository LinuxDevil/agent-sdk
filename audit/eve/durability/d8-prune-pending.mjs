// D8: SqliteStore.prune() promises "Unresolved approvals ... are kept", but it
// deletes the paused turn's checkpoint (and the session transcript) by age.
// A session paused for approval over a long weekend is then half-deleted.
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const store = new SqliteStore(':memory:');
const tools = [defineTool({ name: 'refund', description: 'refund', input: z.object({ amount: z.number() }), needsApproval: true, execute: async () => { globalThis.refunds = (globalThis.refunds ?? 0) + 1; return 'refunded'; } })];
const model = mockModel([(r) => `hi ${r.messages.at(-1).content}`, { toolCalls: [{ name: 'refund', args: { amount: 40 } }] }, 'Refund sent.']);
const agent = createAgent({ provider: model, tools, store });
const s = agent.session({ id: 'cust-7' });
await s.send('hello');
const paused = await s.send('refund my order');
console.log('paused:', paused.finishReason, '| pending():', JSON.stringify(await s.pending()));
await new Promise((r) => setTimeout(r, 15));
console.log('prune({ olderThanMs: 10 }) ->', JSON.stringify(store.prune({ olderThanMs: 10 })), '(stand-in for 7 days)');
console.log('approval still loadable:', Boolean(await store.approvals.load(paused.approvalId)));
const fresh = agent.session({ id: 'cust-7' });
console.log('after prune, pending():', JSON.stringify(await fresh.pending()), '| transcript length:', (await fresh.load()).length);
try {
  const r = await agent.approvals.resolve({ id: paused.approvalId, approved: true });
  console.log('resolve ->', r.finishReason, JSON.stringify(r.text));
} catch (e) { console.log('resolve threw', e.code, e.message.slice(0, 100)); }
const after = (await store.sessions.load('cust-7')) ?? [];
console.log('transcript after resolve:', JSON.stringify(after.map((m) => `${m.role}:${m.content || (m.toolCalls ? 'toolCalls' : '')}`)));
console.log('refund tool executions:', globalThis.refunds ?? 0, '| approval re-resolvable:', Boolean(await store.approvals.load(paused.approvalId)));
