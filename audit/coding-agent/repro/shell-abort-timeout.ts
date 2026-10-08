/**
 * Shell tool timeout and abort on Windows: is the whole process tree killed
 * (a grandchild that keeps writing a heartbeat file must stop)?
 *   npx tsx coding-agent/repro/shell-abort-timeout.ts
 */
import { mkdtempSync, statSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createShellTool, NodeWorkspace } from '@lousho/build-ai-agent';

const root = mkdtempSync(path.join(tmpdir(), 'lousho-abort-'));
// child.js spawns a grandchild that writes beat.txt every 200 ms.
writeFileSync(path.join(root, 'child.js'), `
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', "setInterval(() => require('fs').writeFileSync('beat.txt', String(Date.now())), 200)"], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`);
const ws = new NodeWorkspace({ root });
const tool = createShellTool(ws, { needsApproval: false }) as unknown as { execute: (a: unknown, c: unknown) => Promise<Record<string, unknown>> };
const beat = path.join(root, 'beat.txt');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function check(label: string, run: () => Promise<Record<string, unknown>>) {
  rmSync(beat, { force: true });
  const t0 = Date.now();
  const r = await run();
  const took = Date.now() - t0;
  await sleep(800);
  const m1 = existsSync(beat) ? statSync(beat).mtimeMs : 0;
  await sleep(800);
  const m2 = existsSync(beat) ? statSync(beat).mtimeMs : 0;
  console.log(`${label}: returned after ${took}ms exitCode=${r.exitCode} timedOut=${r.timedOut} aborted=${r.aborted} note=${JSON.stringify(r.note)}; grandchild still alive=${m2 > m1}`);
}

await check('timeout_ms=1500', () => tool.execute({ command: 'node child.js', timeout_ms: 1500 }, { toolCallId: 't' }));
await check('abort after 1500ms', () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1500);
  return tool.execute({ command: 'node child.js' }, { toolCallId: 't', abortSignal: ac.signal });
});
await sleep(500);
try { rmSync(root, { recursive: true, force: true }); } catch (e) { console.log('cleanup failed (a process still holds the dir?):', (e as Error).message.slice(0, 100)); }
