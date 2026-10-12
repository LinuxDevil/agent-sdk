// D17: KVStore approvals resolve as get -> delete (not a claim). Two
// near-simultaneous approve clicks (double click, Slack retry, two reviewers)
// both get the record: the approved tool executes TWICE. fileStore and
// SqliteStore claim atomically, so this is a Workers-only hole.
import { createAgent, defineTool, fileStore } from '@lousho/build-ai-agent';
import { KVStore } from '@lousho/build-ai-agent/kv';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const memKV = () => { const m = new Map(); const tick = () => new Promise((r) => setTimeout(r, 1)); return { get: async (k) => { await tick(); return m.get(k) ?? null; }, put: async (k, v) => { await tick(); m.set(k, v); }, delete: async (k) => { await tick(); m.delete(k); } }; };
for (const [name, store] of [['KVStore', new KVStore(memKV())], ['fileStore', fileStore(mkdtempSync(join(tmpdir(), 'eve-d17-')))]]) {
  let payouts = 0;
  const tools = [defineTool({ name: 'payout', description: 'pay vendor', input: z.object({}), needsApproval: true, execute: async () => { payouts++; return 'paid'; } })];
  const model = mockModel([(r) => (r.messages.at(-1).role === 'tool' ? 'Paid.' : { toolCalls: [{ name: 'payout', args: {} }] })], { onExhausted: 'repeat-last' });
  const paused = await createAgent({ provider: model, tools, store }).send('pay invoice 77', { sessionId: 'inv-77' });
  // two separate requests/isolates, each with its own agent over the same store
  const results = await Promise.allSettled([1, 2].map(() => createAgent({ provider: model, tools, store }).approvals.resolve({ id: paused.approvalId, approved: true })));
  console.log(`[${name}] resolves:`, results.map((r) => (r.status === 'fulfilled' ? r.value.finishReason : r.reason.code)).join(', '), `| payout executed ${payouts}x`, payouts > 1 ? ' FAIL' : ' PASS');
}
