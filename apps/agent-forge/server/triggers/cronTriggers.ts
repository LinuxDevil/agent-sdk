/**
 * Cron triggers inside Studio (R08c): while the server runs, every agent's
 * `cron` triggers fire on schedule through the workspace `TriggerHost`.
 *
 * Durability: each agent's fire cursor lives in
 * `<sidecar>/triggers/state.json` (`CronState`), written atomically under
 * `withAgentLock`. A missing entry, or one whose `expression`/`timezone`
 * no longer match the spec (schedule edited), rewrites the cursor to now
 * WITHOUT firing - a new or edited schedule never bursts. A due window
 * claims the cursor (lastRunAt = now) inside the same lock before
 * dispatching, so a restart after downtime fires exactly once for the
 * missed window and never catches up, and two overlapping `tick()` calls
 * can never double-fire.
 *
 * `sharedSession` is ignored here: RunManager already keeps one chat
 * session per agent; the field only matters to `lousho dev` (S22).
 */
import * as path from 'node:path';

import { CronExpressionError, parseCronExpression, type CronSchedule } from 'lousho/triggers';
import type { TriggerSpec } from 'lousho/spec';

import { readJsonFile, withAgentLock, writeJsonAtomic } from '../storage/atomic';
import { AgentRepo } from '../storage/agentRepo';
import type { TriggerHost } from './triggerHost';

type CronTrigger = Extract<TriggerSpec, { type: 'cron' }>;

/** Per-trigger fire cursor; keyed by trigger id inside one agent's state file. */
export interface CronTriggerCursor {
  lastRunAt: string;
  expression: string;
  timezone: string | null;
}

export interface CronState {
  [triggerId: string]: CronTriggerCursor;
}

export interface CronTriggersDeps {
  /** The workspace root (`ws.ref.root`); `.lousho/agents` hangs off it. */
  baseDir: string;
  host: TriggerHost;
  /** Clock injection for tests. Default: `new Date()`. */
  now?: () => Date;
  /** Poll interval. Default 60_000; the interval is `unref()`ed. */
  tickMs?: number;
}

const DEFAULT_TICK_MS = 60_000;
/** The first tick runs shortly after start so a just-missed window isn't a full minute late. */
const FIRST_TICK_MS = 1_000;

export class CronTriggers {
  private readonly repo: AgentRepo;
  private readonly now: () => Date;
  private readonly tickMs: number;
  private interval: NodeJS.Timeout | undefined;
  private firstTick: NodeJS.Timeout | undefined;
  private inTick: Promise<void> | undefined;
  /** Invalid expressions already logged (`<cron>\n<tz>`), so the error line appears once per schedule. */
  private readonly badSchedules = new Set<string>();

  constructor(private readonly deps: CronTriggersDeps) {
    this.repo = new AgentRepo(deps.baseDir);
    this.now = deps.now ?? (() => new Date());
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  }

  /** Starts the interval (unref'ed) and schedules the first tick ~1s out. */
  start(): void {
    this.interval = setInterval(() => void this.tick().catch(() => {}), this.tickMs);
    this.interval.unref();
    this.firstTick = setTimeout(() => void this.tick().catch(() => {}), FIRST_TICK_MS);
    this.firstTick.unref();
  }

  stop(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
    if (this.firstTick !== undefined) clearTimeout(this.firstTick);
    this.interval = undefined;
    this.firstTick = undefined;
  }

  /**
   * One scheduler pass over every agent. Concurrent calls share the
   * in-flight pass, so two ticks can never race a claim.
   */
  tick(): Promise<void> {
    this.inTick ??= this.tickAll().finally(() => {
      this.inTick = undefined;
    });
    return this.inTick;
  }

  private async tickAll(): Promise<void> {
    const now = this.now();
    for (const agentId of this.repo.listIds()) {
      try {
        await this.tickAgent(agentId, now);
      } catch (error) {
        this.deps.host.log(
          agentId,
          `Cron tick failed: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        );
      }
    }
  }

  private async tickAgent(agentId: string, now: Date): Promise<void> {
    const triggers = this.deps.host.triggersOf(agentId).filter((t): t is CronTrigger => t.type === 'cron');
    const live = new Set(triggers.map((t) => t.id));
    for (const trigger of triggers) {
      await this.tickTrigger(agentId, trigger, now);
    }
    await this.pruneState(agentId, live);
  }

  /** Fires `trigger` when its window is due; the cursor update and the due check share one lock. */
  private async tickTrigger(agentId: string, trigger: CronTrigger, now: Date): Promise<void> {
    let schedule: CronSchedule;
    try {
      schedule = parseCronExpression(trigger.cron, trigger.timezone);
    } catch (error) {
      this.warnBadSchedule(agentId, trigger, error);
      return;
    }
    this.badSchedules.delete(`${trigger.cron}\n${trigger.timezone ?? ''}`);

    const nowIso = now.toISOString();
    const timezone = trigger.timezone ?? null;
    const fire = await withAgentLock(agentId, async () => {
      const state = await this.loadState(agentId);
      const cursor = state[trigger.id];
      // New trigger or an edited schedule: move the cursor to now, never fire.
      if (cursor === undefined || cursor.expression !== trigger.cron || cursor.timezone !== timezone || Number.isNaN(Date.parse(cursor.lastRunAt))) {
        state[trigger.id] = { lastRunAt: nowIso, expression: trigger.cron, timezone };
        await this.saveState(agentId, state);
        return undefined;
      }
      const next = schedule.nextRun(new Date(cursor.lastRunAt));
      if (next.getTime() > now.getTime()) return undefined;
      // Claim the window before dispatching: the cursor moves to now even
      // if the queue is full, so a missed window is never retried.
      state[trigger.id] = { ...cursor, lastRunAt: nowIso };
      await this.saveState(agentId, state);
      return next;
    });
    if (fire === undefined) return;

    const result = this.deps.host.dispatch({
      agentId,
      triggerId: trigger.id,
      input: trigger.prompt,
      event: { type: 'cron', scheduledAt: fire.toISOString(), firedAt: nowIso },
    });
    if (result.ok) {
      this.deps.host.log(agentId, `Cron trigger ${trigger.id} fired`);
    } else if (result.reason === 'queue_full') {
      this.deps.host.log(agentId, `Cron trigger ${trigger.id} skipped: the queue is full`, 'warn');
    } else if (result.reason === 'disabled') {
      // R09 seam: the host rejects dispatches for disabled agents.
      this.deps.host.log(agentId, `Cron trigger ${trigger.id} skipped: the agent is turned off`, 'warn');
    } else {
      this.deps.host.log(agentId, `Cron trigger ${trigger.id} skipped: unknown trigger`, 'warn');
    }
  }

  /** Deletes state entries whose trigger left the spec (or whose agent has no cron triggers left). */
  private async pruneState(agentId: string, live: ReadonlySet<string>): Promise<void> {
    await withAgentLock(agentId, async () => {
      const state = await this.loadState(agentId);
      const stale = Object.keys(state).filter((id) => !live.has(id));
      if (stale.length === 0) return;
      for (const id of stale) delete state[id];
      await this.saveState(agentId, state);
    });
  }

  private statePath(agentId: string): string {
    return path.join(this.repo.sidecarDir(agentId), 'triggers', 'state.json');
  }

  private async loadState(agentId: string): Promise<CronState> {
    const state = await readJsonFile<CronState>(this.statePath(agentId));
    return state !== undefined && typeof state === 'object' ? state : {};
  }

  private saveState(agentId: string, state: CronState): Promise<void> {
    return writeJsonAtomic(this.statePath(agentId), state);
  }

  /** Logs an invalid schedule once per `<expression>\n<timezone>` pair. */
  private warnBadSchedule(agentId: string, trigger: CronTrigger, error: unknown): void {
    const key = `${trigger.cron}\n${trigger.timezone ?? ''}`;
    if (this.badSchedules.has(key)) return;
    this.badSchedules.add(key);
    const message = error instanceof CronExpressionError ? error.message : String(error);
    this.deps.host.log(agentId, `Cron trigger ${trigger.id} has an invalid schedule: ${message}`, 'warn');
  }
}
