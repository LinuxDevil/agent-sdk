/**
 * C8: `agent.recover()` - a background loop that finishes the runs a crash left
 * unfinished, so a durable agent does not need the caller to poll
 * `agent.pending()` and call `agent.resume()` by hand.
 *
 * Each sweep lists the pending runs and resumes every interrupted one
 * (`status: 'in-progress'`). Runs paused on an approval or a question are left
 * to a human. A run still running in some process (or whose crashed holder's
 * lease has not expired yet) is protected by its run lease (`runLease.ts`): its
 * resume fails with `LOUSHO_SESSION_BUSY` before anything runs, and the next
 * sweep tries again. This loop never resumes one run twice at once itself.
 */

import type { PendingRun } from './agentPending';
import { ConfigurationError } from './execution/errors';

/** Options for `agent.recover()`. */
export interface RecoverOptions<TResult = unknown> {
  /** How long to wait between sweeps, ms (default 30 000: one run lease period). */
  intervalMs?: number;
  /** Stops the loop when aborted; resumes in flight are aborted too (their checkpoints stay, a later sweep finishes them). */
  signal?: AbortSignal;
  /**
   * Called when a sweep cannot list the pending runs (`run` undefined) or a
   * resume fails (`run` set). The loop keeps going. Not called for runs
   * another process holds (`LOUSHO_SESSION_BUSY`) or that paused on an
   * approval meanwhile, nor for aborts after `stop()`.
   */
  onError?: (error: unknown, run?: PendingRun) => void;
  /** Called with each run this loop finished, and its result. */
  onRecovered?: (run: PendingRun, result: TResult) => void;
}

/** The loop `agent.recover()` started. */
export interface RunRecovery {
  /** Resolves once the loop stopped (its signal aborted, or `stop()`) and its resumes in flight settled. */
  readonly done: Promise<void>;
  /** Stops the loop (aborting its resumes in flight); resolves as `done`. */
  stop(): Promise<void>;
}

/** What the loop needs of the agent. */
interface RecoveryTarget<TResult> {
  pending: () => Promise<PendingRun[]>;
  resume: (sessionId: string, options: { signal: AbortSignal }) => Promise<TResult | null>;
}

const DEFAULT_INTERVAL_MS = 30_000;

/** Errors a sweep expects: the run is someone else's right now, or it waits on a human. */
function expected(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'LOUSHO_SESSION_BUSY' || code === 'LOUSHO_SESSION_AWAITING_APPROVAL';
}

/** Calls a user callback without letting it break the loop. */
function safely<A extends unknown[]>(callback: ((...args: A) => void) | undefined, ...args: A): void {
  try {
    callback?.(...args);
  } catch {
    // a throwing callback must not stop recovery
  }
}

/** Starts the recovery loop over `target` (see the module comment). */
export function startRecovery<TResult>(target: RecoveryTarget<TResult>, options: RecoverOptions<TResult> = {}): RunRecovery {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new ConfigurationError(`agent.recover(): intervalMs must be a positive number of milliseconds, got ${intervalMs}.`, 'intervalMs');
  }
  const controller = new AbortController();
  const { signal } = controller;
  const outer = options.signal;
  const abort = () => controller.abort(outer?.reason);
  if (outer?.aborted) abort();
  else outer?.addEventListener('abort', abort, { once: true });

  const inFlight = new Map<string, Promise<void>>();
  const report = (error: unknown, run?: PendingRun) => {
    if (!signal.aborted) safely(options.onError, error, run);
  };

  const resume = (run: PendingRun) => {
    const task = target
      .resume(run.sessionId, { signal })
      .then(
        (result) => {
          if (result !== null) safely(options.onRecovered, run, result);
        },
        (error: unknown) => {
          if (!expected(error)) report(error, run);
        }
      )
      .finally(() => inFlight.delete(run.sessionId));
    inFlight.set(run.sessionId, task);
  };

  const sweep = async () => {
    let runs: PendingRun[];
    try {
      runs = await target.pending();
    } catch (error) {
      report(error);
      return;
    }
    for (const run of runs) {
      if (signal.aborted) return;
      // Paused on a human; failed for good (it would fail again: `agent.pending()` shows it); or this loop is on it.
      if (run.status !== 'in-progress' || run.lastError?.retryable === false || inFlight.has(run.sessionId)) continue;
      resume(run);
    }
  };

  const nextSweep = () =>
    new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', wake);
        resolve();
      }, intervalMs);
      signal.addEventListener('abort', wake, { once: true });
    });

  const done = (async () => {
    while (!signal.aborted) {
      await sweep();
      if (!signal.aborted) await nextSweep();
    }
    await Promise.allSettled([...inFlight.values()]);
    outer?.removeEventListener('abort', abort);
  })();

  return {
    done,
    stop() {
      controller.abort();
      return done;
    },
  };
}
