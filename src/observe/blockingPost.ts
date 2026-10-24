/**
 * POSTs that block the calling thread until they settle - the reporter's
 * crash flush. `uncaughtExceptionMonitor` listeners run synchronously and
 * Node exits the moment they return, so an ordinary `fetch` started there
 * never even opens its socket (measured: 0 connections). Here the requests
 * run in a throwaway worker thread with its own event loop while this
 * thread sleeps on `Atomics.wait`; the worker marks each delivered body
 * in a shared array and wakes this thread when it is done.
 *
 * The worker is given no `execArgv` (no loaders such as tsx: it only needs
 * the global `fetch`) and is left running when this returns: the process is
 * about to exit, which terminates it.
 *
 * Builtins load through `getBuiltinModule` (builtins.ts): this module ships
 * in the Cloudflare Worker bundle, where it reports nothing delivered
 * instead of breaking the bundle.
 */
import { getBuiltinModule } from './builtins';

interface WorkerThreadsLike {
  Worker: new (code: string, options: { eval: true; execArgv: string[]; workerData: unknown }) => { unref(): void };
}

/** Shared slots: [0] 0 while the worker runs, 1 once it stopped; [1 + i] 1 once body i got a 2xx. */
const DONE = 0;
const FIRST_BODY = 1;

/**
 * The worker's whole program (CommonJS, `eval: true`): the bodies in order,
 * one at a time, all inside the one deadline. A body the server answers with
 * an error is skipped; no answer at all (down, deadline) stops it.
 * The id literal is double-quoted so the bundle check's probe matcher sees it.
 */
const WORKER_SOURCE = `
const { workerData: d } = process.getBuiltinModule("node:worker_threads");
const flag = new Int32Array(d.flag);
(async () => {
  for (let i = 0; i < d.bodies.length; i++) {
    const left = d.deadline - Date.now();
    if (left <= 0) break;
    const res = await fetch(d.url, { method: 'POST', headers: d.headers, body: d.bodies[i], signal: AbortSignal.timeout(left) });
    if (res.ok) Atomics.store(flag, ${FIRST_BODY} + i, 1);
  }
})().catch(() => undefined).finally(() => { Atomics.store(flag, ${DONE}, 1); Atomics.notify(flag, ${DONE}); });
`;

/**
 * POST each of `bodies` to `url` in order, blocking at most `timeoutMs` in
 * all (worker start-up included). Returns, per body, whether the server
 * answered it 2xx in time; all false on a runtime without worker threads.
 */
export function blockingPost(url: string, headers: Record<string, string>, bodies: readonly string[], timeoutMs: number): boolean[] {
  const none = bodies.map(() => false);
  if (bodies.length === 0) return none;
  try {
    const threads = getBuiltinModule<WorkerThreadsLike>('node:worker_threads');
    if (!threads) return none;
    const flag = new Int32Array(new SharedArrayBuffer(4 * (FIRST_BODY + bodies.length)));
    const deadline = Date.now() + timeoutMs;
    const worker = new threads.Worker(WORKER_SOURCE, { eval: true, execArgv: [], workerData: { flag: flag.buffer, url, headers, bodies, deadline } });
    worker.unref(); // never keeps a process alive past a timed-out wait
    Atomics.wait(flag, DONE, 0, timeoutMs);
    return bodies.map((_, i) => Atomics.load(flag, FIRST_BODY + i) === 1);
  } catch {
    return none;
  }
}
