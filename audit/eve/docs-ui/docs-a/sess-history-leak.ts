// sessions.md:29 says clear() "Empties the transcript and saves it empty (the store holds no messages for the id)".
// sessions.md:269 says "Each checkpoints/<id>.json has a checkpoint-history/<id>.json next to it".
import { createAgent, fileStore } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
const d = join(process.cwd(), 'eve/docs-ui/docs-a/.tmp-hist'); rmSync(d, { recursive: true, force: true });
const agent = createAgent({ provider: mockModel(Array.from({ length: 20 }, (_, i) => `reply ${i}`)), store: fileStore(d) });
const s = agent.session({ id: 'user-42' });
for (let i = 0; i < 10; i++) await s.send(`My SSN-like secret is SECRET-${i}`);
await s.clear();
const hist = readdirSync(join(d, 'checkpoint-history'));
let ckpts: string[] = []; try { ckpts = readdirSync(join(d, 'checkpoints')); } catch {}
console.log('after clear(): sessions/:', readdirSync(join(d, 'sessions')));
console.log('checkpoints/:', ckpts.length, 'checkpoint-history/:', hist.length, 'files, bytes', hist.reduce((n, f) => n + statSync(join(d, 'checkpoint-history', f)).size, 0));
console.log('SECRET strings still on disk in history:', hist.filter((f) => readFileSync(join(d, 'checkpoint-history', f), 'utf8').includes('SECRET-')).length);
console.log('agent.session history() after clear:', (await agent.session({ id: 'user-42' }).history()).length);
// sqlite
const db = join(d, 'agent.db'); const store = new SqliteStore(db);
const a2 = createAgent({ provider: mockModel(Array.from({ length: 20 }, (_, i) => `r${i}`)), store });
const s2 = a2.session({ id: 'u7' }); for (let i = 0; i < 5; i++) await s2.send(`SECRET-${i}`); await s2.clear();
const raw = (store as any).db ?? null;
console.log('sqlite: file contains SECRET after clear:', readFileSync(db).includes('SECRET-') || (() => { try { return readFileSync(db + '-wal').includes('SECRET-'); } catch { return false; } })());
console.log('sqlite prune(0):', JSON.stringify(store.prune({ olderThanMs: 0 })));
store.close();
