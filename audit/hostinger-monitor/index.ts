/**
 * Live audit run of the hostinger-monitor watchdog against OpenRouter.
 *
 *   npx tsx hostinger-monitor/index.ts        (from audit/)
 *
 * Surfaces exercised for real:
 *   1. defineTool HTTP health-check tools (list_monitored / check_endpoint /
 *      list_incidents / open_incident / current_time), plus the live
 *      Hostinger VPS API target when a token is available.
 *   2. Schedules: defineSchedule validation and startSchedules driven through
 *      its own injected `now`/`setTimer` clock (the package exports no
 *      fireSchedule — it is internal), so the real parseCronExpression.nextRun
 *      -> arm -> wait -> fire -> re-arm path runs without wall-clock waits.
 *   3. Durable state: SqliteStore under .runs/monitor.db + .runs/incidents.json,
 *      proven across a simulated restart (second SqliteStore + second agent).
 *   4. Structured output: `output` schema -> result.object incident report.
 *   5. Decision logic: hard failure -> exactly one incident; degraded (404)
 *      and healthy targets are refused by the open_incident floor; tick 2
 *      dedupes instead of re-opening.
 */
import '../_shared/env.ts'; // FIRST: loads root .env (OPENROUTER_API_KEY)
import { hasLiveKey, report } from '../_shared/env.ts';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { createAgent, defineSchedule, startSchedules, type SimpleAgent, type DefinedSchedule } from '@lousho/build-ai-agent';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  catalog, hostingerToken, makeAgent, makeTickSchedule, logEvent,
  escalates, readIncidents, lastChecks,
  DB_PATH, INCIDENTS_FILE, CHECKS_LOG, RUNS_DIR, SESSION_ID,
  TICK1, TICK2, type IncidentReport,
} from './monitor.ts';

if (!hasLiveKey) {
  console.log('OPENROUTER_API_KEY is not set — this harness only runs live.');
  process.exit(1);
}

// Fresh incident log for the run (the SQLite db is kept: it is the "history").
mkdirSync(RUNS_DIR, { recursive: true });
if (existsSync(INCIDENTS_FILE)) rmSync(INCIDENTS_FILE);
if (existsSync(CHECKS_LOG)) rmSync(CHECKS_LOG);

const token = hostingerToken();
report('env: OPENROUTER_API_KEY', true, 'present (not printed)');
report('env: HOSTINGER_API_TOKEN', Boolean(token), token ? 'present via env/~/.claude.json — live Hostinger API target enabled' : 'absent — HTTP-endpoint catalog only');

const targets = catalog(token);
const toolCalls: string[] = [];
const onEvent = (e: any) => {
  if (e.type === 'tool.start' && typeof e.toolName === 'string') toolCalls.push(e.toolName);
  logEvent(e);
};

const store1 = new SqliteStore(DB_PATH);
const agentA = makeAgent(targets, token, { store: store1, onEvent });

/* ------------------------------------------------ 0. defineSchedule guards */
try {
  defineSchedule({ cron: 'definitely not cron', run: async () => {} });
  report('defineSchedule: bad cron rejected', false, 'no error thrown');
} catch (e: any) {
  report('defineSchedule: bad cron rejected', e?.code === 'LOUSHO_SCHEDULE_INVALID', `code=${e?.code}`);
}
try {
  defineSchedule({ cron: '* * * * *' } as any); // neither prompt nor run
  report('defineSchedule: requires prompt|run', false, 'no error thrown');
} catch (e: any) {
  report('defineSchedule: requires prompt|run', e?.code === 'LOUSHO_SCHEDULE_INVALID', `code=${e?.code}`);
}

/**
 * Fire `schedule` once through the REAL startSchedules loop with the SDK's
 * injected clock: arm uses parseCronExpression.nextRun, we then jump `now` to
 * the armed instant and invoke the armed timer. `settled` resolves when the
 * fire's body finished (the schedule's run(), or run.done for prompts).
 */
async function fireOnce(agent: SimpleAgent, schedule: DefinedSchedule, settled: Promise<unknown>) {
  let nowMs = Date.now();
  const timers: { fn: () => void; ms: number }[] = [];
  const errors: unknown[] = [];
  const running = startSchedules(agent, [schedule], {
    now: () => nowMs,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return () => {}; },
    onError: (e) => errors.push(e),
  });
  const firstDelay = timers[0]?.ms;
  nowMs += firstDelay ?? 0;
  timers[0]?.fn();
  await settled;
  running.stop();
  return { firstDelay, timersArmed: timers.length, errors };
}

/* ---------------------- 1. startSchedules: real cron loop, injected clock -- */
let probeDone: () => void;
const probeSettled = new Promise<void>((r) => (probeDone = r));
const probeSchedule = defineSchedule({
  name: 'probe',
  cron: '*/5 * * * *',
  run: async (ctx) => { probeDone(); },
});
const probeRes = await fireOnce(agentA, probeSchedule, probeSettled);
report('startSchedules: cron armed to next boundary', (probeRes.firstDelay ?? 0) > 0 && (probeRes.firstDelay ?? 0) <= 5 * 60_000,
  `armed ${probeRes.firstDelay}ms out, re-armed=${probeRes.timersArmed >= 2} errors=${probeRes.errors.length}`);

/* ---------------- 2. prompt schedule fires a real agent turn (same path) -- */
let promptDone: () => void;
const promptSettled = new Promise<void>((r) => (promptDone = r));
const probeAgent = createAgent({
  model: 'openrouter/openai/gpt-4o-mini',
  instructions: 'Be terse.',
  onEvent: (e) => { if (e.type === 'run.done') promptDone(); },
});
const promptSchedule = defineSchedule({ name: 'prompt-probe', cron: '* * * * *', prompt: 'Reply with exactly: PONG' });
const promptRes = await fireOnce(probeAgent, promptSchedule, promptSettled);
await probeAgent.close();
report('schedule prompt -> agent turn', promptRes.errors.length === 0, `a '* * * * *' prompt schedule ran a real LLM turn via startSchedules (errors=${promptRes.errors.length})`);

/* ----------------------------------------------------------- 3. live tick 1 */
console.log('\n=== TICK 1 (agent A, SqliteStore #1) ===');
let tick1: any;
let tick1Done: () => void;
const tick1Settled = new Promise<void>((r) => (tick1Done = r));
const tick1Res = await fireOnce(agentA, makeTickSchedule(TICK1, (r) => { tick1 = r; tick1Done(); }), tick1Settled);
const obj1 = tick1?.object as IncidentReport | undefined;
report('tick1: schedule fire -> durable session turn', tick1Res.errors.length === 0 && Boolean(tick1), `finishReason=${tick1?.finishReason} steps=${tick1?.steps} toolCalls=${tick1?.toolCalls?.length}`);
report('tick1: structured output parsed', Boolean(obj1), obj1 ? '' : `outputError=${JSON.stringify(tick1?.outputError).slice(0, 300)} text=${JSON.stringify(tick1?.text).slice(0, 200)}`);
if (obj1) {
  console.log('--- TICK 1 INCIDENT REPORT ---');
  console.log(JSON.stringify(obj1, null, 2));
}
const incidents1 = readIncidents();
const hardDown = [...lastChecks.values()].filter((c) => c.hard && !c.ok).map((c) => c.name);
const openTargets = incidents1.filter((i) => i.status === 'open').map((i) => i.endpoint);
report('tick1: check_endpoint covered catalog', targets.every((t) => lastChecks.has(t.name)), `checked=${[...lastChecks.keys()].join(',')}`);
report('tick1: exactly the hard-failed targets have open incidents',
  JSON.stringify([...openTargets].sort()) === JSON.stringify([...hardDown].sort()),
  `open=${JSON.stringify(openTargets)} hardDown=${JSON.stringify(hardDown)}`);
report('tick1: degraded 404 not escalated', !openTargets.includes('lousho-missing-page'), `missing-page check=${JSON.stringify(lastChecks.get('lousho-missing-page')?.detail)}`);
if (obj1) report('tick1: severity matches reality', (obj1.severity === 'critical' || obj1.severity === 'high') === hardDown.length > 0, `severity=${obj1.severity} confidence=${obj1.confidence} floor-escalates=${escalates(obj1)}`);
writeFileSync(join(RUNS_DIR, 'tick1-report.json'), JSON.stringify(obj1 ?? { outputError: tick1?.outputError, text: tick1?.text }, null, 2));

/* ------------------------------------------- 4. restart sim: new store+agent */
store1.close();
const store2 = new SqliteStore(DB_PATH);
const agentB = makeAgent(targets, token, { store: store2, onEvent });
const resumed = await agentB.session({ id: SESSION_ID }).load();
const persisted = resumed.some((m: any) => JSON.stringify(m).includes('dead-vps-sim')) && resumed.length >= 2;
report('restart: transcript survives new SqliteStore + new agent', persisted, `resumed ${resumed.length} messages under session '${SESSION_ID}'`);

/* ----------------------------------------------------------- 5. live tick 2 */
console.log('\n=== TICK 2 (agent B, SqliteStore #2 — post-restart) ===');
let tick2: any;
let tick2Done: () => void;
const tick2Settled = new Promise<void>((r) => (tick2Done = r));
await fireOnce(agentB, makeTickSchedule(TICK2, (r) => { tick2 = r; tick2Done(); }), tick2Settled);
const obj2 = tick2?.object as IncidentReport | undefined;
const incidents2 = readIncidents();
const opens2 = incidents2.filter((i) => i.status === 'open');
report('tick2: run finished + report parsed', Boolean(obj2), `finishReason=${tick2?.finishReason}`);
if (obj2) {
  console.log('--- TICK 2 INCIDENT REPORT ---');
  console.log(JSON.stringify(obj2, null, 2));
}
report('tick2: incident dedupe — still exactly one open incident per hard-down target',
  opens2.length === new Set(opens2.map((i) => i.endpoint)).size && opens2.length === hardDown.length,
  `open=${JSON.stringify(opens2.map((i) => i.endpoint))}`);
writeFileSync(join(RUNS_DIR, 'tick2-report.json'), JSON.stringify(obj2 ?? { outputError: tick2?.outputError, text: tick2?.text }, null, 2));

/* ---------------------------------------------------------------- summary */
console.log('\n=== tool usage (live run) ===');
const counts = toolCalls.reduce((m: Record<string, number>, t) => ((m[t] = (m[t] ?? 0) + 1), m), {});
console.log(JSON.stringify(counts));
report('tools: list_monitored + check_endpoint invoked by the model', Boolean(counts.list_monitored) && (counts.check_endpoint ?? 0) >= targets.length, JSON.stringify(counts));
report('incident log durable on disk', existsSync(INCIDENTS_FILE) && readIncidents().length >= 1, `${INCIDENTS_FILE} -> ${readIncidents().length} record(s)`);

store2.close();
await agentB.close();
await agentA.close();
