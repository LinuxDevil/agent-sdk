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
  ...(mode === 'inflight' ? { flushSize: 1 } : mode === 'backlog' ? { flushSize: 10_000 } : {}),
});
const finish = (id: string): void => {
  const span = { id, name: 'invoke_agent crash-fixture', attributes: {}, startTime: Date.now() };
  reporter.onSpanStart(span);
  reporter.onSpanEnd({ ...span, endTime: Date.now() });
};
finish('crash-span');
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
