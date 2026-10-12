// D4: fileStore / FileSessionStore on Windows: rename-over-existing fails with
// raw EPERM/EACCES/EBUSY when another writer or a reader has the target open.
// No retry, no SDK error code. Two server replicas (or a reader such as
// `lousho sessions` / a backup job) sharing a fileStore dir hit this.
import { fileStore } from '@lousho/build-ai-agent';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'eve-d4-'));
const a = fileStore(dir), b = fileStore(dir);
const msgs = (n) => Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${n}-${i}`.repeat(20) }));
const errors = {};
let ok = 0;
for (let round = 0; round < 50; round++) {
  const ops = [a.sessions.save('chat', msgs(round)), b.sessions.save('chat', msgs(round + 1000)), a.sessions.load('chat'), b.checkpoints.save('chat.turn-0', { agentId: 'x', sessionId: 'chat.turn-0', stepIndex: round, messages: msgs(round), toolCalls: [], usage: {} }), a.checkpoints.load('chat.turn-0')];
  for (const r of await Promise.allSettled(ops)) {
    if (r.status === 'fulfilled') ok++;
    else { const k = `${r.reason.code ?? r.reason.name}`; errors[k] = (errors[k] ?? 0) + 1; }
  }
}
console.log(`platform=${process.platform} ok=${ok} errors=`, errors);
console.log(Object.keys(errors).length ? 'FAIL: raw filesystem errors escape fileStore under concurrent use' : 'PASS');
