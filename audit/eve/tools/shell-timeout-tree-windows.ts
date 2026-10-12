/* TOOLS: does a shell-tool timeout / abort kill the whole process tree on Windows (cmd.exe)?
   Spawns `ping -n 20` (grandchild of node via cmd.exe) with timeout_ms 1500, then checks
   whether a ping.exe started by us is still alive.
   Run: npx tsx eve/tools/shell-timeout-tree-windows.ts */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createShellTool, NodeWorkspace } from '@lousho/build-ai-agent';

const count = () => (execSync('tasklist /FI "IMAGENAME eq PING.EXE" /NH').toString().match(/PING\.EXE/gi) ?? []).length;
const ws = new NodeWorkspace({ root: mkdtempSync(join(tmpdir(), 'eve-tt-')) });
const tool: any = createShellTool(ws, { needsApproval: false });
const before = count();
const t0 = Date.now();
const r = await tool.execute({ command: 'ping -n 20 127.0.0.1', timeout_ms: 1500 }, {});
console.log(`timeout: returned in ${Date.now() - t0}ms timedOut=${r.timedOut} | ping.exe before=${before} after=${count()}`);

const ac = new AbortController();
setTimeout(() => ac.abort(), 1500);
const t1 = Date.now();
const r2 = await tool.execute({ command: 'ping -n 20 127.0.0.1' }, { abortSignal: ac.signal });
console.log(`abort: returned in ${Date.now() - t1}ms aborted=${r2.aborted} | ping.exe after=${count()}`);
