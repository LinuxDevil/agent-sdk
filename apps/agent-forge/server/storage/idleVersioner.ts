/**
 * IdleVersioner - one workspace's "edited a while ago" scheduler.
 *
 * Autosave (`PUT /agents/:id`) only rewrites `<id>.yaml`; the version
 * history's `editor` capture instead happens here: every successful
 * autosave `touch`es the agent's timer, and `IDLE_VERSION_DELAY_MS` of
 * quiet after the last write fires `capture` for that agent. An explicit
 * save (`POST /agents/:id/versions`) or a delete `cancel`s the pending
 * timer - the save already wrote the version - and server close
 * `flushAll()`s so a pending capture is not lost.
 *
 * The class only schedules. The capture itself (reconcile + capture under
 * `withAgentLock`) is supplied by {@link createIdleVersioner}, so the
 * timer callback runs outside any request and outside the agent lock.
 */
import { withAgentLock } from './atomic';
import type { VersionStore } from './versionStore';

/** How long an agent must go without an autosave before its working copy becomes an `editor` version (Contract B). */
export const IDLE_VERSION_DELAY_MS = 60_000;

export interface IdleVersionerOptions {
  /** Idle delay before `capture` fires; defaults to {@link IDLE_VERSION_DELAY_MS}. */
  delayMs?: number;
  /** Writes the version; called with no lock held. */
  capture: (agentId: string) => Promise<void>;
  /** Timer factory; defaults to `setTimeout` (unref'd so shutdown and tests are never held open). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Timer cancel; defaults to `clearTimeout`. */
  clearTimer?: (handle: unknown) => void;
}

/**
 * Per-agent debounce over "a version should exist for the working copy":
 * `touch` (re)arms an agent's timer, `cancel` drops it, `flushAll` runs
 * every pending capture now. Capture failures are swallowed - the timer
 * path has nobody to reject to, so `capture` is expected to log its own
 * errors (`createIdleVersioner`'s does).
 */
export class IdleVersioner {
  private readonly delayMs: number;
  private readonly capture: (agentId: string) => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  /** One pending timer per agent id; the fired callback deletes its own entry before capturing. */
  private readonly timers = new Map<string, unknown>();

  constructor(options: IdleVersionerOptions) {
    this.delayMs = options.delayMs ?? IDLE_VERSION_DELAY_MS;
    this.capture = options.capture;
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref();
        return handle;
      });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** (Re)starts `agentId`'s idle timer - called after every successful autosave. */
  touch(agentId: string): void {
    this.cancel(agentId);
    const handle = this.setTimer(() => {
      this.timers.delete(agentId);
      void this.capture(agentId).catch(() => {});
    }, this.delayMs);
    this.timers.set(agentId, handle);
  }

  /** Drops `agentId`'s pending timer (an explicit save already wrote the version, or the agent is gone). */
  cancel(agentId: string): void {
    const handle = this.timers.get(agentId);
    if (handle === undefined) return;
    this.clearTimer(handle);
    this.timers.delete(agentId);
  }

  /** Runs every pending capture now (server close); the timers are cleared first so nothing fires twice. */
  async flushAll(): Promise<void> {
    const pending = [...this.timers.keys()];
    for (const agentId of pending) this.cancel(agentId);
    await Promise.all(pending.map((agentId) => this.capture(agentId).catch(() => {})));
  }
}

/**
 * A workspace's wired IdleVersioner: each capture reconciles a hand edit
 * first, then snapshots the working copy as an `editor` version (`create`
 * for the first, `update` after - an unchanged spec is the VersionStore's
 * no-op, so a timer firing on an unmodified file writes nothing). It runs
 * inside `withAgentLock` - the timer fires outside any request - and a
 * failure logs a warning instead of throwing: there is no request to
 * answer it.
 */
export function createIdleVersioner(versions: VersionStore, delayMs = IDLE_VERSION_DELAY_MS): IdleVersioner {
  return new IdleVersioner({
    delayMs,
    capture: async (agentId) => {
      try {
        await withAgentLock(agentId, async () => {
          await versions.reconcileExternalEdit(agentId);
          const kind = (await versions.latest(agentId)) === undefined ? 'create' : 'update';
          await versions.capture(agentId, { kind, source: 'editor' });
        });
      } catch (error) {
        console.warn(`[agent-forge] idle version for ${agentId} failed: ${(error as Error).message}`);
      }
    },
  });
}
