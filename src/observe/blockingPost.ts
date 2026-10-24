/**
 * POSTs that block the calling thread until they settle - the reporter's
 * crash flush. `uncaughtExceptionMonitor` listeners run synchronously and
 * Node exits the moment they return, so an ordinary `fetch` started there
 * never even opens its socket (measured: 0 connections). Here the requests
 * run in a throwaway worker thread with its own event loop while this
 * thread sleeps on `Atomics.wait`; the worker counts each delivered body
 * into a shared flag and wakes this thread when it is done.
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

/** Shared flag slots: [0] 0 while the worker runs, 1 once it stopped; [1] bodies delivered so far. */
const DONE = 0;
const DELIVERED = 1;

/**
 * The worker's whole program (CommonJS, `eval: true`): the bodies in order,
 * one at a time, all inside the one deadline; the first failure stops it.
 * The id literal is double-quoted so the bundle check's probe matcher sees it.
 */
const WORKER_SOURCE = `
const { workerData: d } = process.getBuiltinModule("node:worker_threads");
const flag = new Int32Array(d.flag);
(async () => {
  for (const body of d.bodies) {
    const left = d.deadline - Date.now();
    if (left <= 0) break;
    const res = await fetch(d.url, { method: 'POST', headers: d.headers, body, signal: AbortSignal.timeout(left) });
    if (!res.ok) break;
    Atomics.add(flag, ${DELIVERED}, 1);
  }
})().catch(() => undefined).finally(() => { Atomics.store(flag, ${DONE}, 1); Atomics.notify(flag, ${DONE}); });
`;

/**
 * POST each of `bodies` to `url` in order, blocking at most `timeoutMs` in
 * all (worker start-up included). Returns how many leading bodies the server
 * answered 2xx in time: the rest were not delivered (a failure, the
 * deadline, or a runtime without worker threads, which delivers 0).
 */
export function blockingPost(url: string, headers: Record<string, string>, bodies: readonly string[], timeoutMs: number): number {
  if (bodies.length === 0) return 0;
  try {
    const threads = getBuiltinModule<WorkerThreadsLike>('node:worker_threads');
    if (!threads) return 0;
    const flag = new Int32Array(new SharedArrayBuffer(8));
    const deadline = Date.now() + timeoutMs;
    const worker = new threads.Worker(WORKER_SOURCE, { eval: true, execArgv: [], workerData: { flag: flag.buffer, url, headers, bodies, deadline } });
    worker.unref(); // never keeps a process alive past a timed-out wait
    Atomics.wait(flag, DONE, 0, timeoutMs);
    return Atomics.load(flag, DELIVERED);
  } catch {
    return 0;
  }
}
