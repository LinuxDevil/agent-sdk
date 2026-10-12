// D3: LOUSHO_SESSION_BUSY (the B5 fix, AgentSession.assertBaseUnchanged) is a
// non-atomic load -> compare -> save. Two writers that cannot share the
// in-process queue (two store objects over the same data = two processes /
// two server replicas) whose turns finish at the same moment both pass the
// check and both commit: one turn is silently lost and both callers got 'ok'.
import { createAgent, fileStore } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'eve-d3-'));
const dbPath = join(dir, 'agent.db');
const cases = [
  ['fileStore(dir) x2', () => fileStore(dir)],
  ['new SqliteStore(path) x2', () => new SqliteStore(dbPath)],
];
for (const [name, make] of cases) {
  let release;
  const gate = new Promise((r) => (release = r)); // both model calls answer at the same instant
  const model = () => mockModel([async (req) => { await gate; return `ack ${req.messages.at(-1).content}`; }], { onExhausted: 'repeat-last' });
  const replicaA = createAgent({ provider: model(), store: make() });
  const replicaB = createAgent({ provider: model(), store: make() });
  const pending = Promise.allSettled([
    replicaA.session({ id: 'chat' }).send('from replica A'),
    replicaB.session({ id: 'chat' }).send('from replica B'),
  ]);
  setTimeout(release, 20);
  const res = await pending;
  const stored = (await make().sessions.load('chat')) ?? [];
  const users = stored.filter((m) => m.role === 'user').map((m) => m.content);
  console.log(`[${name}] send results:`, res.map((r) => (r.status === 'fulfilled' ? 'ok' : `rejected(${r.reason.code})`)).join(', '));
  console.log(`[${name}] persisted user turns:`, JSON.stringify(users));
  const ok = res.filter((r) => r.status === 'fulfilled').length;
  console.log(ok > users.length ? `  FAIL: ${ok} turns reported success, ${users.length} persisted` : '  PASS');
}
