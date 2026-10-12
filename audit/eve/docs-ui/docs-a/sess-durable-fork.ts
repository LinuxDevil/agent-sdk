import { createAgent, defineTool, PropagatingToolError, memoryStore } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
const err = async (p: any) => { try { await p; return 'no throw'; } catch (e: any) { return `${e?.name} ${e?.code ?? ''} ${String(e?.message).slice(0, 140)}`; } };
const d = join(process.cwd(), 'eve/docs-ui/docs-a/.tmp-dur'); rmSync(d, { recursive: true, force: true });
// interrupted turn via PropagatingToolError, then resume in a "new process" (new agent, same db)
let count = 0;
const flaky = defineTool({ name: 'flaky', description: 'd', input: z.object({}), execute: async () => { count++; if (count === 1) throw new PropagatingToolError('crash'); return 'ok now'; } });
const store1 = new SqliteStore(join(d, 'agent.db'));
const a1 = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'flaky', args: {} }] }, 'finished']), tools: [flaky], store: store1 });
console.log('turn 1:', await err(a1.session({ id: 'user-42' }).send('go')));
console.log('pending after crash:', JSON.stringify(await a1.session({ id: 'user-42' }).pending()));
store1.close();
const store2 = new SqliteStore(join(d, 'agent.db'));
const m2 = mockModel(['finished']);
const a2 = createAgent({ provider: m2, tools: [flaky], store: store2 });
const finished = await a2.resume('user-42');
console.log('resume:', finished?.text, '| pending now:', await a2.session({ id: 'user-42' }).pending(), '| tool runs:', count, '| model calls on resume:', m2.calls.length);
console.log('transcript:', (await (async () => { const s = a2.session({ id: 'user-42' }); await s.load(); return s.messages.map((m: any) => m.role); })()).join(','));
console.log('resume none:', await a2.resume('nobody'));
// fork errors
const s = a2.session({ id: 'user-42' }); await s.load();
console.log('fork 99:', await err(s.fork({ fromStep: 99 })));
console.log('fork own id:', await err(s.fork({ fromStep: 0, id: 'user-42' })));
const f = await s.fork({ fromStep: 1 }); console.log('fork id:', f.id, f.messages.length);
const f2 = await s.fork({ fromStep: 0 }); console.log('fork2 id:', f2.id, f2.messages.length);
console.log('prune:', JSON.stringify(store2.prune({ olderThanMs: 7 * 864e5 })));
store2.close();
console.log('after close:', await err((async () => store2.prune({ olderThanMs: 1 }))()));
// stream break early: transcript unchanged
const a3 = createAgent({ provider: mockModel(['one two three four', 'b']) });
const s3 = a3.session();
for await (const e of s3.stream('hi')) { if (e.type === 'text.delta') break; }
console.log('after early break transcript len:', s3.messages.length);
