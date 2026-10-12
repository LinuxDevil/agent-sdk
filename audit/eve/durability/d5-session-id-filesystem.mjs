// D5: session ids are validated as [A-Za-z0-9_-]{1,128} (case-sensitive) but
// fileStore maps them 1:1 to file names. On Windows/macOS (case-insensitive
// filesystems) 'Alice' and 'alice' are the SAME transcript; Windows device
// names (CON, NUL, AUX, COM1...) pass validation and fail/vanish.
import { createAgent, fileStore } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'eve-d5-'));
const store = fileStore(dir);
const agent = createAgent({ provider: mockModel([(r) => `echo ${r.messages.at(-1).content}`], { onExhausted: 'repeat-last' }), store });
await agent.session({ id: 'Alice' }).send('my SSN is 078-05-1120');
const bob = await agent.session({ id: 'alice' }).load();
console.log(`platform=${process.platform}: session 'alice' (a different user) loads ${bob.length} messages:`, JSON.stringify(bob.map((m) => m.content)));
console.log(bob.length ? '  FAIL: case-variant session id reads another session\'s transcript' : '  PASS');
const sql = new SqliteStore(':memory:');
await sql.sessions.save('Alice', [{ role: 'user', content: 'x' }]);
console.log(`  (SqliteStore for comparison: 'alice' ->`, (await sql.sessions.load('alice')) ?? 'undefined', ')');

for (const id of ['CON', 'nul', 'COM1', 'aux']) {
  try {
    await store.sessions.save(id, [{ role: 'user', content: 'hi' }]);
    const back = await store.sessions.load(id);
    console.log(`id '${id}': save ok, load ->`, back === undefined ? 'undefined (DATA SILENTLY LOST)' : `${back.length} msgs`);
  } catch (e) {
    console.log(`id '${id}': passed assertSessionId, then raw fs error ${e.code}: ${e.message.slice(0, 60)}`);
  }
}
console.log('files on disk:', readdirSync(join(dir, 'sessions')));
