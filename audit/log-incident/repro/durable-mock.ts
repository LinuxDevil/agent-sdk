/**
 * Deterministic crash/resume repro (mockModel, real child processes, real stores).
 *
 *   npx tsx log-incident/repro/durable-mock.ts
 *
 * Case A  one turn with 3 parallel calls: #1 finishes fast, #2 kills the process, #3 still running.
 * Case B  one turn with 3 parallel calls: #2 and #3 finish fast, #1 kills the process later.
 * Case C  two turns (sequential); the turn-2 tool kills the process. fileStore instead of SQLite.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', '.lousho', 'durable-mock');
const LEDGER = join(dir, 'ledger.jsonl');

if (process.argv[2] === 'child') {
  const [, , , kase, phase] = process.argv;
  const { createAgent, defineTool, fileStore } = await import('@lousho/build-ai-agent');
  const { SqliteStore } = await import('@lousho/build-ai-agent/sqlite');
  const { mockModel } = await import('@lousho/build-ai-agent/testing');
  const { z } = await import('zod');
  const plan: Record<string, Record<string, { ms: number; crash?: boolean }>> = {
    A: { c1: { ms: 50 }, c2: { ms: 300, crash: true }, c3: { ms: 5000 } },
    B: { c1: { ms: 600, crash: true }, c2: { ms: 50 }, c3: { ms: 50 } },
    C: { c1: { ms: 50 }, c2: { ms: 50 }, c3: { ms: 200, crash: true } },
  };
  const probe = defineTool({
    name: 'probe', description: 'probe', input: z.object({ id: z.string() }),
    execute: async ({ id }, { toolCallId }) => {
      appendFileSync(LEDGER, JSON.stringify({ phase, ev: 'start', id, toolCallId }) + '\n');
      const p = plan[kase][id];
      await new Promise((r) => setTimeout(r, p.ms));
      if (p.crash && phase === 'run') { appendFileSync(LEDGER, JSON.stringify({ phase, ev: 'crash', id }) + '\n'); process.exit(137); }
      appendFileSync(LEDGER, JSON.stringify({ phase, ev: 'done', id, toolCallId }) + '\n');
      return { id, ok: true };
    },
  });
  const call = (id: string) => ({ id: `call_${id}`, name: 'probe', args: { id } });
  const script =
    phase === 'run'
      ? kase === 'C'
        ? [{ toolCalls: [call('c1'), call('c2')] }, { toolCalls: [call('c3')] }, 'unused']
        : [{ toolCalls: [call('c1'), call('c2'), call('c3')] }, 'unused']
      : ['all probes done'];
  const model = mockModel(script as any);
  const store = kase === 'C' ? fileStore(join(dir, 'files')) : new SqliteStore(join(dir, `${kase}.db`));
  const agent = createAgent({ provider: model, tools: [probe], store, toolConcurrency: 4 });
  const r = phase === 'run' ? await agent.send('go', { sessionId: kase }) : await agent.resume(kase);
  console.log(`[child ${kase}/${phase}] finish=${r?.finishReason} modelCalls=${model.calls.length} toolResults=${r?.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId).join(',')}`);
  process.exit(0);
}

mkdirSync(dir, { recursive: true });
for (const kase of ['A', 'B', 'C']) {
  if (existsSync(LEDGER)) rmSync(LEDGER);
  for (const f of [`${kase}.db`, `${kase}.db-wal`, `${kase}.db-shm`]) if (existsSync(join(dir, f))) rmSync(join(dir, f));
  if (kase === 'C' && existsSync(join(dir, 'files'))) rmSync(join(dir, 'files'), { recursive: true });
  const self = fileURLToPath(import.meta.url);
  const a = spawnSync(process.execPath, ['--import', 'tsx', self, 'child', kase, 'run'], { encoding: 'utf8' });
  const b = spawnSync(process.execPath, ['--import', 'tsx', self, 'child', kase, 'resume'], { encoding: 'utf8' });
  const led = readFileSync(LEDGER, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const fmt = (ph: string) => led.filter((e) => e.phase === ph).map((e) => `${e.ev}:${e.id}`).join(' ');
  const doneBefore = new Set(led.filter((e) => e.phase === 'run' && e.ev === 'done').map((e) => e.id));
  const rerun = led.filter((e) => e.phase === 'resume' && e.ev === 'start').map((e) => e.id);
  console.log(`\n=== case ${kase}: run exit=${a.status} resume exit=${b.status}`);
  console.log(`   run    ledger: ${fmt('run')}`);
  console.log(`   resume ledger: ${fmt('resume')}`);
  console.log(`   ${(b.stdout + b.stderr).trim().split('\n').filter((l) => !/^\s+at /.test(l)).slice(0, 6).join('\n   ')}`);
  console.log(`   finished before crash: [${[...doneBefore]}]  re-executed on resume: [${rerun}]  finished-but-re-executed: [${rerun.filter((id) => doneBefore.has(id))}]`);
}
