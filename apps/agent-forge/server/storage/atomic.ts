/**
 * Shared storage primitives for the Studio server: an atomic file write
 * (`writeFileAtomic`) and a per-agent in-process mutex (`withAgentLock`).
 * Every `.lousho/` store writes through the first and serializes its
 * read-modify-write cycles through the second, so two routes touching the
 * same agent's files can never interleave a partial write or a lost update.
 *
 * Both live here rather than inside any one store because later stores
 * (versions, drafts, meta, layout) all need the identical pair - this module
 * is the single place the convention is defined.
 */
import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * `fs.rename` replaces an existing target atomically, but on Windows it
 * fails with `EPERM`/`EACCES`/`EBUSY` while another process (an editor,
 * antivirus) still holds the file open. Those are transient, so rename is
 * retried; anything else fails immediately.
 */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Back-off before each rename retry: 5 attempts total (initial + 4 waits). */
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRenameError(error: unknown): boolean {
  return RETRYABLE_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '');
}

/** `fsPromises.rename` with bounded retries on transient Windows lock errors. */
async function retryRename(tmpPath: string, filePath: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsPromises.rename(tmpPath, filePath);
      return;
    } catch (error) {
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !isRetryableRenameError(error)) throw error;
      await sleep(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Writes `data` to `filePath` via `<filePath>.<8 hex>.tmp` + rename: a reader
 * polling the target only ever sees the old complete file or the new
 * complete one, never a partially written file. Parent directories are
 * created as needed. When the rename ultimately fails (see `retryRename`
 * for which errors are retried), the temp file is deleted (best effort) and
 * the error is rethrown.
 */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const tmpPath = `${filePath}.${randomBytes(4).toString('hex')}.tmp`;
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(tmpPath, data);
  try {
    await retryRename(tmpPath, filePath);
  } catch (error) {
    await fsPromises.rm(tmpPath, { force: true }).catch(() => {
      // Best-effort cleanup: the rename error is what the caller needs.
    });
    throw error;
  }
}

/**
 * The agent ids the current async context already holds the lock for.
 * `AsyncLocalStorage` (not a module variable) because the "held" set must
 * follow a call chain across `await`s: a plain variable would see locks
 * held by unrelated interleaved requests.
 */
const heldAgentIds = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Per-agent FIFO queue, stored as the promise the *next* caller must wait
 * on. `lockTails.get(id)` is the tail of the queue: each call appends a new
 * tail that settles when that call's `fn` has finished. Entries are deleted
 * once the queue drains so the map doesn't grow with every agent ever seen.
 */
const lockTails = new Map<string, Promise<void>>();

/**
 * Runs `fn` inside an AsyncLocalStorage context that records `agentId` as
 * held, so a nested `withAgentLock(agentId, ...)` further down the same
 * call chain throws the re-entry error instead of deadlocking on itself.
 */
function runHeld<T>(held: ReadonlySet<string> | undefined, agentId: string, fn: () => Promise<T>): Promise<T> {
  const nextHeld: ReadonlySet<string> = held ? new Set([...held, agentId]) : new Set([agentId]);
  return heldAgentIds.run(nextHeld, fn);
}

/**
 * Runs `fn` after every earlier `withAgentLock(agentId, ...)` call has
 * settled - a FIFO in-process mutex per agent id (Studio is single-process,
 * so a `Map` of promise tails is the whole lock; there is deliberately no
 * cross-process piece). Different ids never wait on each other. A rejected
 * `fn` still releases the lock so the next queued call runs. Re-entering
 * the same id inside `fn` throws `withAgentLock re-entered for '<id>'`
 * rather than deadlocking; nesting a *different* id is allowed.
 */
export async function withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const held = heldAgentIds.getStore();
  if (held?.has(agentId)) {
    throw new Error(`withAgentLock re-entered for '${agentId}'`);
  }

  const prev = lockTails.get(agentId) ?? Promise.resolve();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => released);
  lockTails.set(agentId, tail);

  await prev;
  try {
    return await runHeld(held, agentId, fn);
  } finally {
    release();
    if (lockTails.get(agentId) === tail) lockTails.delete(agentId);
  }
}
