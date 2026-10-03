/**
 * N13b: partial tool results. A tool's `execute` may be an `async function*`:
 * every `yield` is a complete snapshot that replaces the previous one (reported
 * as a `tool.partial` event), and the last one is the tool's result. A
 * `return` value is ignored; a generator that yields nothing has the result
 * `undefined`. Snapshots never reach the model, the transcript or a checkpoint.
 */

/**
 * Whether `value` (what a tool's `execute` returned) streams snapshots: an
 * async iterator that is also async iterable - what an `async function*`
 * returns. A value that is only async iterable (a `ReadableStream`, say) has
 * no `next` method and stays an ordinary result.
 */
export function isPartialStream(value: unknown): value is AsyncIterator<unknown> & AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { next?: unknown }).next === 'function' &&
    Symbol.asyncIterator in value
  );
}

/**
 * Runs `stream` to its end, handing every snapshot to `onSnapshot`, and
 * resolves to the last one. A throw inside the generator rejects with it.
 * When `signal` aborts, it stops waiting at once, rejects with the signal's
 * reason and calls the generator's `return()`, so its `finally` blocks run
 * (an async generator runs them once its current `await` settles). Snapshots
 * it yields after that are never reported.
 */
export async function drainPartialStream(
  stream: AsyncIterator<unknown>,
  onSnapshot: (snapshot: unknown) => void,
  signal?: AbortSignal
): Promise<unknown> {
  let last: unknown = undefined;
  let finished = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const step = await untilAborted(stream.next(), signal);
      if (step.done) {
        finished = true;
        return last;
      }
      last = step.value;
      onSnapshot(step.value);
    }
  } finally {
    if (!finished) closeQuietly(stream);
  }
}

/** Asks the generator to finish (its `finally` blocks run); a failure there is not this run's concern. */
function closeQuietly(stream: AsyncIterator<unknown>): void {
  try {
    void Promise.resolve(stream.return?.(undefined)).catch(() => undefined);
  } catch {
    // A `return()` that throws synchronously: nothing left to clean up here.
  }
}

/** `step`, or the signal's reason as soon as it aborts (a late rejection of `step` is swallowed). */
function untilAborted<T>(step: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return step;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    step.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
