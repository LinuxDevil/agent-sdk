// D2: two concurrent agent.send(msg, { sessionId }) on the same id (the
// documented durable-execution conversation API, docs/durable-execution.md).
// No queue and no LOUSHO_SESSION_BUSY: both read the same 'finished'
// checkpoint, both succeed, and the last write silently drops the other turn.
import { createAgent, memoryStore, fileStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const echo = async (req) => {
  const last = req.messages.at(-1);
  return { text: `ack ${last.content}`, delayMs: 30 };
};
for (const [name, store] of [['memoryStore', memoryStore()], ['fileStore', fileStore(mkdtempSync(join(tmpdir(), 'eve-d2-')))]]) {
  const agent = createAgent({ provider: mockModel([echo], { onExhausted: 'repeat-last' }), store });
  await agent.send('first', { sessionId: 'chat-42' });
  const results = await Promise.allSettled([
    agent.send('order pizza', { sessionId: 'chat-42' }),
    agent.send('order sushi', { sessionId: 'chat-42' }),
  ]);
  console.log(`[${name}] concurrent sends:`, results.map((r) => r.status === 'fulfilled' ? `ok(${r.value.text})` : `rejected(${r.reason.code})`).join(', '));
  const cp = await store.checkpoints.load('chat-42');
  const users = cp.messages.filter((m) => m.role === 'user').map((m) => m.content);
  console.log(`[${name}] stored user turns:`, JSON.stringify(users));
  console.log(users.includes('order pizza') && users.includes('order sushi') ? '  PASS' : '  FAIL: a turn that returned success is missing from the durable conversation');
}
