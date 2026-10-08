/**
 * Durable execution audit: crash the triage run mid-flight, resume it in a
 * new process, and check from an execution ledger that finished tools are not
 * re-executed.
 *
 *   npx tsx log-incident/durable.ts                 # orchestrates everything
 *   (internally spawns: durable.ts child <run|resume> <sessionId> <crashMode>)
 *
 * crash modes:
 *   exit-in-tool:N   process.exit(137) inside the N-th tool execution (tool running)
 *   kill-in-model:N  parent SIGKILLs the child while model call N is in flight
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '.lousho');
const DB = join(dir, 'durable.db');
const LEDGER = join(dir, 'durable-ledger.jsonl');

type Ledger = { pid: number; phase: string; ev: 'start' | 'done' | 'model'; tool?: string; toolCallId?: string; args?: unknown; n?: number };
const ledger = (e: Ledger) => appendFileSync(LEDGER, JSON.stringify(e) + '\n');

if (process.argv[2] === 'child') {
  const [, , , phase, sessionId, crashMode = 'none'] = process.argv;
  const { SqliteStore } = await import('@lousho/build-ai-agent/sqlite');
  const { toolTap } = await import('./logs.js');
  const { triageAgent, TASK, capped, provider0 } = await import('./agent.js');
  const [kind, nStr] = crashMode.split(':');
  const N = Number(nStr);
  let calls = 0;
  toolTap.onCall = async (tool, args, ctx) => {
    calls++;
    ledger({ pid: process.pid, phase, ev: 'start', tool, toolCallId: ctx.toolCallId, args });
    if (phase === 'run' && kind === 'exit-in-tool' && calls === N) {
      console.log(`[child] crashing inside tool #${calls} (${tool} ${ctx.toolCallId})`);
      await new Promise((r) => setTimeout(r, 400)); // let sibling parallel calls finish + checkpoint
      process.exit(137);
    }
  };
  let modelCalls = 0;
  const store = new SqliteStore(DB);
  const agent = triageAgent({
    store,
    quiet: false,
    provider: capped(provider0()),
    hooks: [{ name: 'ledger', preGenerate: () => { modelCalls++; ledger({ pid: process.pid, phase, ev: 'model', n: modelCalls }); console.log(`[child] model call #${modelCalls}`); } } as any],
    onEvent: (e) => {
      if (e.type === 'tool.done' || e.type === 'tool.error') ledger({ pid: process.pid, phase, ev: 'done', tool: (e as any).toolName, toolCallId: (e as any).toolCallId });
      if (e.type === 'tool.resume') console.log(`[child] tool.resume ${(e as any).toolName} ${(e as any).toolCallId}`);
      if (e.type === 'tool.start') console.log(`[child] tool.start ${(e as any).toolName} ${(e as any).toolCallId}`);
    },
  });
  try {
    const r = phase === 'run' ? await agent.send(TASK, { sessionId }) : await agent.resume(sessionId);
    console.log(`[child] ${phase} finished: ${r ? `${r.finishReason} steps=${r.steps} object=${!!r.object} usage=${JSON.stringify(r.usage)}` : 'null (nothing to resume)'}`);
    if (r?.object) console.log('[child] rootCause:', (r.object as any).rootCause);
  } catch (e) {
    console.log(`[child] ${phase} threw ${(e as Error).name}: ${(e as Error).message.slice(0, 200)}`);
  }
  store.close();
  process.exit(0);
}

// ---------------- orchestrator ----------------
function runChild(args: string[], killWhen?: (line: string) => boolean): Promise<{ code: number | null; out: string; killed: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), 'child', ...args], { cwd: join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let killed = false;
    const onData = (b: Buffer) => {
      const s = b.toString();
      out += s;
      process.stdout.write(s.replace(/^/gm, '    | '));
      if (!killed && killWhen && s.split('\n').some(killWhen)) {
        killed = true;
        setTimeout(() => { console.log('    [parent] SIGKILL child'); child.kill('SIGKILL'); }, 1500);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => resolve({ code, out, killed }));
  });
}

const mode = process.argv[2] ?? 'exit-in-tool:2';
mkdirSync(dir, { recursive: true });
for (const f of [DB, DB + '-wal', DB + '-shm', LEDGER]) if (existsSync(f)) rmSync(f);
const sessionId = `durable-${mode.replace(':', '-')}`;
console.log(`== durable scenario ${mode}, session ${sessionId}`);

const [kind, n] = mode.split(':');
const first = await runChild(['run', sessionId, mode], kind === 'kill-in-model' ? (l) => l.includes(`[child] model call #${n}`) : undefined);
console.log(`== first process exited code=${first.code} killed=${first.killed}`);

// inspect the checkpoint between processes
{
  const { SqliteStore } = await import('@lousho/build-ai-agent/sqlite');
  const { getCheckpointHistory } = await import('@lousho/build-ai-agent');
  const store = new SqliteStore(DB);
  const cp = await store.checkpoints.load(sessionId);
  const msgs = (cp as any)?.messages ?? [];
  console.log(`== checkpoint after crash: status=${(cp as any)?.status} stepIndex=${(cp as any)?.stepIndex} messages=${msgs.length} roles=${msgs.map((m: any) => m.role[0]).join('')}`);
  const tail = msgs.at(-1);
  if (tail?.toolCalls) console.log(`   last assistant turn has ${tail.toolCalls.length} tool calls without results`);
  const hist = await getCheckpointHistory(store.checkpoints, sessionId);
  console.log(`   history: ${hist?.map((h) => `${h.step}:${h.status}:${h.checkpoint.messages.length}`).join(' ')}`);
  store.close();
}

const second = await runChild(['resume', sessionId]);
console.log(`== resume process exited code=${second.code}`);

// ledger analysis
const entries: Ledger[] = readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const starts = entries.filter((e) => e.ev === 'start');
const byId = new Map<string, Ledger[]>();
for (const s of starts) byId.set(s.toolCallId!, [...(byId.get(s.toolCallId!) ?? []), s]);
const firstPid = entries[0]?.pid;
const doneInFirst = new Set(entries.filter((e) => e.ev === 'done' && e.pid === firstPid).map((e) => e.toolCallId));
console.log('== ledger');
for (const [id, runs] of byId) {
  console.log(`   ${id} ${runs[0].tool} executions=${runs.length} phases=${runs.map((r) => r.phase).join(',')} finishedBeforeCrash=${doneInFirst.has(id)}`);
}
const reExecutedFinished = [...byId].filter(([id, runs]) => doneInFirst.has(id) && runs.length > 1);
console.log(`== model calls: run=${entries.filter((e) => e.ev === 'model' && e.phase === 'run').length} resume=${entries.filter((e) => e.ev === 'model' && e.phase === 'resume').length}`);
console.log(`== VERDICT: finished tools re-executed on resume: ${reExecutedFinished.length === 0 ? 'none (OK)' : reExecutedFinished.map(([id]) => id).join(', ')}`);
