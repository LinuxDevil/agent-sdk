/**
 * `call`, or its rejection with `signal`'s reason once `signal` aborts - work
 * that ignores the signal is not waited for, though `call` keeps running.
 * With `graceMs`, the abort side waits that long first, so a settlement that
 * lands while the run unwinds still wins (a tool released just as the run
 * aborted keeps its real result, like ToolBatch.settled()'s drained wait).
 */
export function abortable<T>(call: Promise<T>, signal: AbortSignal | undefined, graceMs = 0): Promise<T> {
  if (!signal) return call;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (graceMs > 0) timer = setTimeout(() => reject(signal.reason), graceMs);
      else reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    call.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
    });
  });
}
