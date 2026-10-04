/**
 * Per-key task serialization shared by `itemsProvider()` (./providers) and
 * `vectorMemory()` (./vectorProvider): tasks for the same scope key run one
 * at a time in call order, so a concurrent load-modify-save on one key can
 * never interleave (two `add()`s both keep their item); different keys run
 * concurrently. Internal to src/memory - not re-exported from ./index.
 */
export function keyedQueue(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const queues = new Map<string, Promise<unknown>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const done = (queues.get(key) ?? Promise.resolve()).then(task);
    // The queued tail swallows `done`'s rejection so one failed task does not
    // block the key's later tasks (the caller still gets `done` itself).
    const tail = done.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => queues.get(key) === tail && queues.delete(key));
    return done;
  };
}
