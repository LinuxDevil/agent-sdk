/* TOOLS: (a) grep tool runs a model-supplied RegExp synchronously on the event loop -> a
   catastrophic-backtracking pattern freezes the whole process; the abort signal cannot help.
   (b) edit_file silently corrupts non-UTF-8 files (latin1 bytes -> U+FFFD) in unrelated lines.
   Run: npx tsx eve/tools/fs-grep-redos-encoding.ts */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsTools, NodeWorkspace } from '@lousho/build-ai-agent';

const root = mkdtempSync(join(tmpdir(), 'eve-fs-'));
writeFileSync(join(root, 'data.txt'), 'a'.repeat(28) + '!\n');
// latin1 file: "café = 1\nx = 2\n" with é as single byte 0xE9
writeFileSync(join(root, 'legacy.ini'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x3d, 0x20, 0x31, 0x0a, 0x78, 0x20, 0x3d, 0x20, 0x32, 0x0a]));

const ws = new NodeWorkspace({ root });
const tools: any[] = createFsTools(ws, { approvals: false } as any);
const byName = (n: string) => tools.find((t) => t.name === n);
console.log('tools:', tools.map((t) => t.name).join(','));

// (b) encoding corruption
const before = readFileSync(join(root, 'legacy.ini'));
console.log('edit result:', await byName('edit_file').execute({ path: 'legacy.ini', old_string: 'x = 2', new_string: 'x = 3' }, {}));
const after = readFileSync(join(root, 'legacy.ini'));
console.log('before bytes[0..5]:', before.subarray(0, 5).toString('hex'), ' after:', after.subarray(0, 7).toString('hex'),
  after.includes(Buffer.from([0xef, 0xbf, 0xbd])) ? '=> CORRUPTED (U+FFFD written into line 1)' : '=> intact');

// (a) ReDoS: measure event-loop stall while grep runs, with an abort after 200ms
const ac = new AbortController();
setTimeout(() => ac.abort(), 200);
let ticks = 0;
const iv = setInterval(() => ticks++, 10);
const t0 = Date.now();
const res = await byName('grep').execute({ pattern: '^(a+)+$', path: 'data.txt' }, { abortSignal: ac.signal });
clearInterval(iv);
const ms = Date.now() - t0;
console.log(`grep returned after ${ms}ms; timer ticks during it: ${ticks} (expected ~${Math.round(ms / 10)} if loop were free); abort fired: ${ac.signal.aborted}; result: ${String(res).slice(0, 40)}`);
