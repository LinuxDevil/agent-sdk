// D16: SqliteStore uses node:sqlite's synchronous DatabaseSync with a 5 s busy
// timeout. When another process holds the write lock (a second replica, a
// prune(), a backup), every store call blocks the WHOLE event loop - all
// HTTP requests, SSE streams, timers - for up to 5 s, then throws a raw
// SQLITE_BUSY "database is locked".
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const db = join(mkdtempSync(join(tmpdir(), 'eve-d16-')), 'agent.db');
new SqliteStore(db).close();
const holder = spawn(process.execPath, ['-e', `
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(${JSON.stringify(db)});
  d.exec('BEGIN IMMEDIATE'); console.log('locked');
  setTimeout(() => { d.exec('COMMIT'); process.exit(0); }, ${process.argv[2] ?? 3000});
`], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => holder.stdout.once('data', r));
const store = new SqliteStore(db);
let ticks = 0;
const t = setInterval(() => ticks++, 10);
const start = Date.now();
let outcome;
try { await store.sessions.save('chat', [{ role: 'user', content: 'hi' }]); outcome = 'ok'; }
catch (e) { outcome = `${e.code ?? ''} ${e.errcode ?? ''} ${e.message}`; }
const blocked = Date.now() - start;
await new Promise((r) => setTimeout(r, 50));
clearInterval(t);
console.log(`save() took ${blocked} ms -> ${outcome}; 10ms-interval ticks during that window: ${ticks <= 6 ? ticks + ' (event loop frozen)' : ticks}`);
holder.kill();
