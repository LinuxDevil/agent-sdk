/**
 * Spawned by reporter.test.ts ('crash flush'): build a reporter with its
 * default exit hooks, finish one span (buffered: the interval flush is far
 * off and the batch is below the size threshold), then die without closing
 * it - the way an agent script dies of a bug after a run.
 *
 *   node --import tsx crashAfterRun.mts <mode>
 *
 * - throw:    a top-level throw (Node reports it with origin 'unhandledRejection')
 * - reject:   an unhandled promise rejection
 * - inflight: flushSize 1, so the span's batch is already in a POST the
 *             collector holds open when a timer callback throws
 * - backlog:  1500 spans pending (past the daemon's 1000-event batch cap), then a top-level throw
 * - bigbacklog: 30 spans of ~100KB input (~12MB with their start events, input riding twice:
 *             past the 4MB batch budget, under the crash flush's 16MB), then a top-level throw
 * - hugebacklog: 200 spans of ~200KB input (~160MB with their start events, past the
 *             outbox and crash budgets), then a top-level throw; stamps `thrown-at=`
 *             and `exit-at=` (ms) on stderr
 * - openroot: a run left open (its root start queued, no end) behind 100 child spans of
 *             ~100KB input (~20MB: past the crash flush's 16MB, under the outbox's 32MB), then a top-level throw
 * - handled:  the script has its own 'uncaughtException' listener, so it
 *             survives the throw, finishes a second span and closes normally
 * - capture:  the same through process.setUncaughtExceptionCaptureCallback (REPL, domains)
 *
 * Env: LOUSHO_OBSERVE (collector URL), LOUSHO_FIXTURE_CWD (identity dir).
 */
import { observeExporter } from '../reporter';

const mode = process.argv[2] ?? 'throw';
const reporter = observeExporter({
  url: process.env.LOUSHO_OBSERVE,
  cwd: process.env.LOUSHO_FIXTURE_CWD,
  project: 'crash-fixture',
  agentName: 'crash-fixture',
  heartbeatIntervalMs: 0,
  ...(mode === 'inflight' ? { flushSize: 1 } : ['backlog', 'bigbacklog', 'hugebacklog', 'openroot'].includes(mode) ? { flushSize: 10_000 } : {}),
});
const finish = (id: string, attributes: Record<string, unknown> = {}): void => {
  const span = { id, name: 'invoke_agent crash-fixture', attributes, startTime: Date.now() };
  reporter.onSpanStart(span);
  reporter.onSpanEnd({ ...span, endTime: Date.now() });
};
finish('crash-span');
if (mode === 'bigbacklog') for (let i = 0; i < 30; i++) finish(`big-${i}`, { 'gen_ai.input.messages': 'x'.repeat(100 * 1024) });
if (mode === 'hugebacklog') {
  for (let i = 0; i < 200; i++) finish(`huge-${i}`, { 'gen_ai.input.messages': 'x'.repeat(200 * 1024) });
  process.on('exit', () => process.stderr.write(`exit-at=${Date.now()}\n`));
  process.stderr.write(`thrown-at=${Date.now()}\n`);
}
if (mode === 'openroot') {
  reporter.onSpanStart({ id: 'open-run', name: 'invoke_agent crash-fixture', attributes: {}, startTime: Date.now() });
  for (let i = 0; i < 100; i++) {
    const child = { id: `child-${i}`, parentId: 'open-run', name: 'chat', attributes: { 'gen_ai.input.messages': 'x'.repeat(100 * 1024) }, startTime: Date.now() };
    reporter.onSpanStart(child);
    reporter.onSpanEnd({ ...child, endTime: Date.now() });
  }
}
if (mode === 'backlog') for (let i = 1; i < 1500; i++) finish(`crash-span-${i}`);

if (mode === 'reject') {
  void Promise.reject(new Error('fixture: unhandled rejection after run'));
} else if (mode === 'inflight') {
  setTimeout(() => {
    throw new Error('fixture: uncaught exception after run');
  }, 300);
} else if (mode === 'handled' || mode === 'capture') {
  const survive = (error: Error): void => {
    console.error(`handled: ${error.message}`);
    finish('after-span');
    void reporter.close();
  };
  if (mode === 'capture') process.setUncaughtExceptionCaptureCallback(survive);
  else process.on('uncaughtException', survive);
  setTimeout(() => {
    throw new Error('fixture: uncaught exception after run');
  }, 10);
} else {
  throw new Error('fixture: uncaught exception after run');
}
