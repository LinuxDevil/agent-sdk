/**
 * The monitoring child's status sweep: a daemon-side interval (default 30s)
 * that rewrites `agents.status` from heartbeat freshness and emits the alerts
 * the webhooks (alerts.ts) then deliver.
 *
 * What one pass does:
 * - Recompute every non-`stopped` agent's status from `last_heartbeat` age vs
 *   its heartbeat interval (`freshnessStatus`, shared with the read path so
 *   `GET /api/v1/agents` never disagrees with the stored value).
 * - Persist only transitions. `stopped` rows are skipped - a graceful
 *   `agent.deregister` never ages into `down`.
 * - On a transition to `down` the agent crashed (no deregister landed): its
 *   open sessions and unfinished observations flip to `interrupted`, so dead
 *   runs do not look alive.
 * - Per instance (one reporter process of an agent): while the agent is
 *   healthy - some process of it still heartbeats - an instance whose own
 *   heartbeats went quiet past the `stale` boundary (~2 missed beats) is
 *   dead, not slow: its open runs flip to `interrupted` and it is
 *   forgotten. When no process of the agent is healthy the agent-level
 *   `down` path above decides instead.
 * - Check today's error rate (day rollups) against the configured threshold;
 *   the crossing alert fires once per agent per day bucket, so a fleet stuck
 *   over the line warns once, not every 30s.
 *
 * Retention rides the same loop: with `retentionDays` > 0, the first pass and
 * then at most one pass per 24h prune finished traces older than the window
 * (`pruneBefore`; open runs and active sessions are kept). The sweep never
 * VACUUMs - `lousho observe prune` does that on demand.
 *
 * Idle sessions close on the same loop: with `sessionIdleMs` > 0, every pass
 * ends the `active` sessions with no open observation whose last activity is
 * older than the window (`endIdleSessions`), so retention can prune them and
 * Threads stops showing finished conversations as live. New activity reopens
 * one on ingest (store.ts).
 */

import type { SqlDatabase } from '../storage/sqlite/driver';
import type { AlertEvent } from './alerts';
import {
  HEARTBEAT_INTERVAL_DEFAULT_MS,
  endIdleSessions,
  freshnessStatus,
  heartbeatIntervalFromMeta,
  interruptAgentWork,
  interruptInstance,
  pruneBefore,
  setAgentStatus,
  transaction,
} from './store';

/** How often the daemon sweeps; shorter than any freshness threshold. */
const SWEEP_INTERVAL_MS = 30_000;

const DAY_MS = 86_400_000;

/** One agent's status rewrite in a sweep pass. `crashed` = a transition to `down`. */
export interface AgentStatusTransition {
  agent_id: string;
  project: string | null;
  name: string | null;
  from: string;
  to: 'healthy' | 'stale' | 'down';
  /** Epoch ms of the pass that made the transition. */
  at: number;
  crashed: boolean;
}

export interface SweepResult {
  transitions: AgentStatusTransition[];
  /** Alerts this pass produced (status-down + error-rate crossings); the caller delivers them. */
  alerts: AlertEvent[];
}

export interface SweepPassOptions {
  /** Today's error rate (0..1) at which an `agent.error_rate` alert fires. */
  errorRateThreshold?: number;
  /** Edge memory for that alert - `agent_id` -> the day bucket already alerted on. */
  errorRateState?: Map<string, number>;
}

/**
 * Interrupt the open runs of every instance gone quiet past `stale` while
 * another process of its agent is still healthy, and forget it. Each
 * instance is judged on its own heartbeat interval (else the agent's) and on
 * the daemon's receive times, so a sibling with a slower cadence or a skewed
 * clock is not taken for dead. "Another process is healthy" is another
 * healthy instance, or - for an older SDK reporting without an instance -
 * the agent row's own freshness.
 */
function sweepInstances(db: SqlDatabase, now: number): void {
  const rows = db
    .prepare(
      `SELECT i.agent_id, i.instance_id, i.last_heartbeat, i.heartbeat_interval_ms, a.last_heartbeat AS agent_heartbeat, a.meta
       FROM agent_instances i JOIN agents a ON a.agent_id = i.agent_id`
    )
    .all();
  const age = (ts: unknown): number => Math.max(0, now - Number(ts ?? 0));
  const healthy = rows.map((row) => {
    const interval = Number(row.heartbeat_interval_ms ?? heartbeatIntervalFromMeta(row.meta) ?? HEARTBEAT_INTERVAL_DEFAULT_MS);
    return freshnessStatus(age(row.last_heartbeat), interval) === 'healthy';
  });
  rows.forEach((row, i) => {
    if (healthy[i]) return;
    const agentInterval = heartbeatIntervalFromMeta(row.meta) ?? HEARTBEAT_INTERVAL_DEFAULT_MS;
    const otherAlive =
      rows.some((other, j) => j !== i && healthy[j] && other.agent_id === row.agent_id) ||
      freshnessStatus(age(row.agent_heartbeat), agentInterval) === 'healthy';
    if (otherAlive) interruptInstance(db, String(row.agent_id), String(row.instance_id), now);
  });
}

/**
 * One sweep pass: recompute statuses, persist transitions, interrupt crashed
 * agents' open work, and return the alerts this pass produced. The row
 * updates run in one transaction (same rule as ingest); alert delivery is
 * the caller's job so this stays synchronous and testable.
 */
export function sweepAgents(db: SqlDatabase, now: number = Date.now(), options: SweepPassOptions = {}): SweepResult {
  const transitions: AgentStatusTransition[] = [];
  const interrupted = new Map<string, { sessions: number; observations: number }>();
  transaction(db, () => {
    sweepInstances(db, now);
    for (const row of db
      .prepare('SELECT agent_id, project, name, first_seen, last_heartbeat, status, meta FROM agents')
      .all()) {
      const stored = String(row.status ?? 'healthy');
      if (stored === 'stopped') continue;
      const agentId = String(row.agent_id);
      const lastHeartbeat = row.last_heartbeat === null ? null : Number(row.last_heartbeat);
      // An agent that never heartbeated is fresh until first_seen says otherwise.
      const anchor = lastHeartbeat ?? Number(row.first_seen);
      const interval = heartbeatIntervalFromMeta(row.meta) ?? HEARTBEAT_INTERVAL_DEFAULT_MS;
      const next = freshnessStatus(Math.max(0, now - anchor), interval);
      if (next === stored) continue;
      setAgentStatus(db, agentId, next, now);
      // 'down' without a deregister is a crash: flip the agent's open work so
      // dead runs stop looking alive.
      if (next === 'down') interrupted.set(agentId, interruptAgentWork(db, agentId, now));
      transitions.push({
        agent_id: agentId,
        project: (row.project as string | null) ?? null,
        name: (row.name as string | null) ?? null,
        from: stored,
        to: next,
        at: now,
        crashed: next === 'down',
      });
    }
  });

  const alerts: AlertEvent[] = [];
  for (const transition of transitions) {
    if (transition.to !== 'down') continue;
    const flipped = interrupted.get(transition.agent_id) ?? { sessions: 0, observations: 0 };
    alerts.push({
      type: 'agent.status',
      agent_id: transition.agent_id,
      project: transition.project,
      status: 'down',
      at: transition.at,
      details: {
        from: transition.from,
        ...(transition.name !== null ? { name: transition.name } : {}),
        interrupted_sessions: flipped.sessions,
        interrupted_observations: flipped.observations,
      },
    });
  }

  const threshold = options.errorRateThreshold;
  if (threshold !== undefined) {
    const seen = options.errorRateState ?? new Map<string, number>();
    // The same UTC day bucket ingest writes and `runs_today`/`error_rate_today` read.
    const dayStart = now - (now % DAY_MS);
    const metrics = new Map<string, { runs: number; errors: number }>();
    for (const row of db
      .prepare("SELECT agent_id, metric, value FROM rollups WHERE granularity = 'day' AND bucket_start = ?")
      .all(dayStart)) {
      const entry = metrics.get(String(row.agent_id)) ?? { runs: 0, errors: 0 };
      if (row.metric === 'runs') entry.runs += Number(row.value);
      else if (row.metric === 'errors') entry.errors += Number(row.value);
      metrics.set(String(row.agent_id), entry);
    }
    for (const [agentId, metric] of metrics) {
      if (metric.runs === 0 || metric.errors === 0) continue;
      const rate = metric.errors / metric.runs;
      // Edge-triggered, once per agent per day bucket: crossing the line is
      // heard once, not re-shouted every sweep while the day stays red.
      if (rate < threshold || seen.get(agentId) === dayStart) continue;
      seen.set(agentId, dayStart);
      const agent = db.prepare('SELECT project, name, status FROM agents WHERE agent_id = ?').get(agentId);
      alerts.push({
        type: 'agent.error_rate',
        agent_id: agentId,
        project: (agent?.project as string | null) ?? null,
        status: String(agent?.status ?? 'unknown'),
        at: now,
        details: {
          error_rate: rate,
          threshold,
          runs: metric.runs,
          errors: metric.errors,
          bucket_start: dayStart,
          ...(agent?.name != null ? { name: agent.name } : {}),
        },
      });
    }
  }
  return { transitions, alerts };
}

export interface StatusSweepOptions {
  /** Pass cadence (default {@link SWEEP_INTERVAL_MS}); `<= 0` leaves the sweep manual-only (tests). */
  intervalMs?: number;
  /** Injectable clock; default `Date.now`. */
  now?: () => number;
  /** See {@link SweepPassOptions.errorRateThreshold}. */
  errorRateThreshold?: number;
  /** Receives each pass's alerts; typically `alerter.post` (alerts.ts). */
  onAlerts?: (alerts: readonly AlertEvent[]) => void;
  /**
   * Retention window in days: finished traces older than this are pruned on
   * the first pass and then at most once per 24h. Only a finite number `> 0`
   * enables it: unset, `0`, a negative value or `NaN` never prunes.
   */
  retentionDays?: number;
  /**
   * Idle window in ms: each pass ends `active` sessions with no open
   * observation and no activity for this long. Only a finite number `> 0`
   * enables it: unset, `0`, a negative value or `NaN` never ends a session.
   */
  sessionIdleMs?: number;
}

export interface StatusSweep {
  /** Run one pass now - the timer's tick, and the test/daemon hook for an on-demand sweep. */
  run(at?: number): SweepResult;
  stop(): void;
}

/**
 * The session pass {@link startStatusSweep} runs first each tick: before the
 * prune (a session idle past the retention window goes in the same pass) and
 * before the status pass, so a session that finished cleanly ends as `ended`
 * rather than `interrupted` when its agent goes down in this pass. Kept apart
 * like the prune: a failure is logged and never costs the pass its alerts.
 */
function idleSessionPass(db: SqlDatabase, idleMs: number | undefined): (at: number) => void {
  // Anything but a finite positive number (unset, 0, negative, NaN) disables it.
  if (idleMs === undefined || !Number.isFinite(idleMs) || idleMs <= 0) return () => undefined;
  return (at) => {
    try {
      endIdleSessions(db, at, idleMs);
    } catch (error) {
      console.error('[lousho observe] idle session pass failed:', error);
    }
  };
}

/**
 * The daemon's sweep loop. The first pass runs immediately: agents that died
 * while the daemon was down are marked (and reported) at boot, not one
 * interval late. The timer is unref'd and swallows its own errors - a broken
 * pass must neither kill nor keep alive the process.
 */
export function startStatusSweep(db: SqlDatabase, options: StatusSweepOptions = {}): StatusSweep {
  const intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const errorRateSeen = new Map<string, number>();
  const days = options.retentionDays;
  // Anything but a finite positive number (unset, 0, negative, NaN) disables retention.
  const retentionMs = days !== undefined && Number.isFinite(days) && days > 0 ? days * DAY_MS : 0;
  let lastPruneAt: number | undefined;
  // Kept apart from the status pass: a failed prune is logged and retried a
  // day later (not every 30s), and never costs the pass its transitions/alerts.
  const prune = (at: number): void => {
    if (retentionMs <= 0 || (lastPruneAt !== undefined && at - lastPruneAt < DAY_MS)) return;
    lastPruneAt = at;
    try {
      pruneBefore(db, at - retentionMs);
    } catch (error) {
      console.error('[lousho observe] retention prune failed:', error);
    }
  };
  const endIdle = idleSessionPass(db, options.sessionIdleMs);
  const run = (at: number = now()): SweepResult => {
    endIdle(at);
    prune(at);
    const result = sweepAgents(db, at, {
      ...(options.errorRateThreshold !== undefined ? { errorRateThreshold: options.errorRateThreshold } : {}),
      errorRateState: errorRateSeen,
    });
    if (result.alerts.length > 0) options.onAlerts?.(result.alerts);
    return result;
  };
  try {
    run();
  } catch (error) {
    console.error('[lousho observe] initial sweep failed:', error);
  }
  const timer =
    intervalMs > 0
      ? setInterval(() => {
          try {
            run();
          } catch (error) {
            console.error('[lousho observe] sweep failed:', error);
          }
        }, intervalMs)
      : undefined;
  timer?.unref?.();
  return {
    run,
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
    },
  };
}
