/**
 * A POST that blocks the calling thread until it settles - the reporter's
 * crash flush. `uncaughtExceptionMonitor` listeners run synchronously and
 * Node exits the moment they return, so an ordinary `fetch` started there
 * never even opens its socket (measured: 0 connections). Here the request
 * runs in a throwaway worker thread with its own event loop while this
 * thread sleeps on `Atomics.wait`; the worker flips a shared flag when the
 * response (or an error) arrives.
 *
 * The worker is given no `execArgv` (no loaders such as tsx: it only needs
 * the global `fetch`) and is left running when this returns: the process is
 * about to exit, which terminates it.
 *
 * Builtins load through `process.getBuiltinModule`: this module ships in the
 * Cloudflare Worker bundle (see WORKER_SAFE_BUILTIN_PROBE), where it reports
 * `false` instead of breaking the bundle.
 */

interface WorkerThreadsLike {
  Worker: new (code: string, options: { eval: true; execArgv: string[]; workerData: unknown }) => { unref(): void };
}

// Named to match the worker leak check's exempted call pattern (see
// WORKER_SAFE_BUILTIN_PROBE in src/deploy/adapters/cloudflare.ts). Do not rename.
function getBuiltinModule<T>(name: string): T | undefined {
  if (typeof process === 'undefined') return undefined;
  return (process.getBuiltinModule?.(name) as T | undefined) ?? undefined;
}

const PENDING = 0;
const OK = 1;

/** The worker's whole program (CommonJS, `eval: true`): one fetch, then publish the outcome. */
const WORKER_SOURCE = `
const { workerData: d } = process.getBuiltinModule("node:worker_threads");
const flag = new Int32Array(d.flag);
const done = (state) => { Atomics.store(flag, 0, state); Atomics.notify(flag, 0); };
fetch(d.url, { method: 'POST', headers: d.headers, body: d.body, signal: AbortSignal.timeout(d.timeoutMs) })
  .then((res) => done(res.ok ? ${OK} : 2), () => done(2));
`;

/**
 * POST `body` to `url`, blocking at most `timeoutMs` (worker start-up
 * included). True only when the server answered 2xx in time; false on any
 * failure, a timeout, or a runtime without worker threads.
 */
export function blockingPost(url: string, headers: Record<string, string>, body: string, timeoutMs: number): boolean {
  const threads = getBuiltinModule<WorkerThreadsLike>('node:worker_threads');
  if (!threads || typeof SharedArrayBuffer === 'undefined') return false;
  try {
    const flag = new SharedArrayBuffer(4);
    const worker = new threads.Worker(WORKER_SOURCE, { eval: true, execArgv: [], workerData: { flag, url, headers, body, timeoutMs } });
    worker.unref(); // never keeps a process alive past a timed-out wait
    Atomics.wait(new Int32Array(flag), 0, PENDING, timeoutMs);
    return Atomics.load(new Int32Array(flag), 0) === OK;
  } catch {
    return false;
  }
}
