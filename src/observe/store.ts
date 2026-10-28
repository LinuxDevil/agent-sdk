/**
 * The collector's store: one SQLite file (default `~/.lousho/observe.db`)
 * holding the platform's whole data plane.
 *
 * Why these choices:
 * - WAL + `busy_timeout=5000` at open (the index contract): Studio reads
 *   never block the single writer, and a second reader process waits rather
 *   than erroring.
 * - One transaction per ingest batch: the upserts and the rollup recompute
 *   commit or roll back together, so a crash mid-batch leaves no half-trace.
 * - Upsert by row primary key everywhere (`obs_id` is the reporter's
 *   TraceLine.id): a resent batch is idempotent and `updated_at` gives
 *   last-writer-wins - except that an observation with `end` set is never
 *   overwritten by one without: a run's root arrives twice (an eager start
 *   with `end` NULL, then the finished span), in either order.
 * - `rollups` is a disposable derivation, never a second write path: each
 *   batch recomputes the bucket rows it touches with INSERT ... SELECT ...
 *   GROUP BY inside the same transaction (a resend recomputes the same
 *   numbers, it can never double count), and `rebuildRollups()` repairs the
 *   whole table from `observations` on demand.
 * - `usage_*`/`cost_*` are stored verbatim: the daemon never recomputes
 *   StepUsage, and the `cost_partial`/`usage_estimated` flags survive to
 *   Studio.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadDatabaseSync, type SqlDatabase } from '../storage/sqlite/driver';
import { SDKError } from '../execution/errors';
import { migrateObserve } from './schema';
import { OBSERVE_INSTANCE_ATTR, OBSERVE_TRUNCATE_CHARS, type IngestEvent, type ObservationData } from './envelope';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Granularity labels as stored in `rollups.granularity`. */
const ROLLUP_GRANULARITIES = { hour: HOUR_MS, day: DAY_MS } as const;
export type RollupGranularity = keyof typeof ROLLUP_GRANULARITIES;

// The metrics `rollups` keeps per (bucket, agent) - runs, errors, cost_usd,
// input/output tokens, latency_ms - all over root observations (a run's
// `invoke_agent` span); the SELECT list in the rollup SQL is the source of truth.

/** Open (creating the directory and file as needed), configure and migrate the observe database. */
export function openDb(path: string): SqlDatabase {
  const DatabaseSync = loadDatabaseSync();
  const location = path === ':memory:' ? path : resolve(path);
  if (location !== ':memory:') mkdirSync(dirname(location), { recursive: true });
  const db = new DatabaseSync(location);
  try {
    if (location !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
    migrateObserve(db);
  } catch (error) {
    db.close();
    throw new SDKError(`Could not open the observe database at ${location}: ${(error as Error).message}`, 'LOUSHO_STORAGE_FAILED', {
      cause: error,
    });
  }
  return db;
}

/** Databases with a `transaction()` open; a nested call joins the outer one. */
const openTransactions = new WeakSet<SqlDatabase>();

/**
 * `work` in one write transaction (`BEGIN IMMEDIATE`), rolled back when it
 * throws. Called inside another `transaction()` on the same db it just runs
 * `work` there, so a throw rolls back the outer transaction as a whole.
 */
export function transaction<T>(db: SqlDatabase, work: () => T): T {
  if (openTransactions.has(db)) return work();
  db.exec('BEGIN IMMEDIATE');
  openTransactions.add(db);
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // the transaction is already gone; keep the original error
    }
    throw error;
  } finally {
    openTransactions.delete(db);
  }
}

/** Cut `value` at the contract limit; `cut` flags the row `truncated` (Studio shows it, so it must be set). */
function truncateField(value: string | undefined, cut: { truncated: boolean }): string | null {
  if (value === undefined) return null;
  if (value.length <= OBSERVE_TRUNCATE_CHARS) return value;
  cut.truncated = true;
  return value.slice(0, OBSERVE_TRUNCATE_CHARS);
}

const OBS_UPSERT = `
  INSERT INTO observations (
    obs_id, trace_id, session_id, agent_id, parent_obs_id, kind, name,
    start, "end", status, input, output, model,
    usage_input_tokens, usage_output_tokens, usage_cached_tokens, usage_reasoning_tokens,
    cost_usd, cost_partial, usage_estimated, truncated, attrs, instance_id, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(obs_id) DO UPDATE SET
    trace_id = excluded.trace_id,
    session_id = excluded.session_id,
    agent_id = excluded.agent_id,
    parent_obs_id = excluded.parent_obs_id,
    kind = excluded.kind,
    name = excluded.name,
    start = excluded.start,
    "end" = excluded."end",
    -- an open re-send (a requeued start) keeps a verdict the sweep already gave
    status = CASE WHEN excluded."end" IS NULL THEN COALESCE(excluded.status, observations.status) ELSE excluded.status END,
    input = excluded.input,
    output = excluded.output,
    model = excluded.model,
    usage_input_tokens = excluded.usage_input_tokens,
    usage_output_tokens = excluded.usage_output_tokens,
    usage_cached_tokens = excluded.usage_cached_tokens,
    usage_reasoning_tokens = excluded.usage_reasoning_tokens,
    cost_usd = excluded.cost_usd,
    cost_partial = excluded.cost_partial,
    usage_estimated = excluded.usage_estimated,
    truncated = excluded.truncated,
    attrs = excluded.attrs,
    instance_id = excluded.instance_id,
    updated_at = excluded.updated_at
  -- A finished row is final: a run's start event (end NULL) arriving after its
  -- end event - reordered by a requeue - must not reopen it.
  WHERE excluded."end" IS NOT NULL OR observations."end" IS NULL
`;

/**
 * New activity in a closed (`ended`/`interrupted`) session: the observation's
 * latest moment (its end, else its start) is past the session's `ended_at`.
 * A re-sent or reordered event for activity at or before it is not new.
 */
const SESSION_REOPENS = `(sessions.status != 'active'
  AND (sessions.ended_at IS NULL OR COALESCE(excluded.ended_at, excluded.started_at) > sessions.ended_at))`;

/**
 * A session row is derived from whatever observations carry its id; there is
 * no session event in the envelope. New activity reopens a closed session as
 * if it were inserted fresh: `active`, `ended_at` = this observation's end.
 */
const SESSION_UPSERT = `
  INSERT INTO sessions (session_id, agent_id, started_at, ended_at, status, updated_at)
  VALUES (?, ?, ?, ?, 'active', ?)
  ON CONFLICT(session_id) DO UPDATE SET
    agent_id = COALESCE(excluded.agent_id, sessions.agent_id),
    started_at = MIN(sessions.started_at, excluded.started_at),
    status = CASE WHEN ${SESSION_REOPENS} THEN 'active' ELSE sessions.status END,
    ended_at = CASE
      WHEN ${SESSION_REOPENS} THEN excluded.ended_at
      WHEN excluded.ended_at IS NULL THEN sessions.ended_at
      WHEN sessions.ended_at IS NULL THEN excluded.ended_at
      ELSE MAX(sessions.ended_at, excluded.ended_at)
    END,
    updated_at = excluded.updated_at
`;

const HEARTBEAT_UPSERT = `
  INSERT INTO agents (agent_id, project, name, version, first_seen, last_heartbeat, status, meta, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 'healthy', ?, ?)
  ON CONFLICT(agent_id) DO UPDATE SET
    project = COALESCE(excluded.project, agents.project),
    name = COALESCE(excluded.name, agents.name),
    version = COALESCE(excluded.version, agents.version),
    last_heartbeat = MAX(COALESCE(agents.last_heartbeat, 0), excluded.last_heartbeat),
    status = 'healthy',
    meta = COALESCE(excluded.meta, agents.meta),
    updated_at = excluded.updated_at
`;

const DEREGISTER_UPSERT = `
  INSERT INTO agents (agent_id, first_seen, last_heartbeat, status, updated_at)
  VALUES (?, ?, ?, 'stopped', ?)
  ON CONFLICT(agent_id) DO UPDATE SET
    status = 'stopped',
    last_heartbeat = MAX(COALESCE(agents.last_heartbeat, 0), excluded.last_heartbeat),
    updated_at = excluded.updated_at
`;

const SCORE_UPSERT = `
  INSERT INTO scores (score_id, trace_id, obs_id, name, value, source, comment, agent_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(score_id) DO UPDATE SET
    trace_id = excluded.trace_id,
    obs_id = excluded.obs_id,
    name = excluded.name,
    value = excluded.value,
    source = excluded.source,
    comment = excluded.comment,
    agent_id = excluded.agent_id,
    updated_at = excluded.updated_at
`;

const PROMPT_USE_UPSERT = `
  INSERT INTO prompt_uses (obs_id, prompt_id, version, created_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(obs_id, prompt_id) DO UPDATE SET
    version = excluded.version
`;

const INSTANCE_UPSERT = `
  INSERT INTO agent_instances (agent_id, instance_id, hostname, pid, heartbeat_interval_ms, first_seen, last_heartbeat)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(agent_id, instance_id) DO UPDATE SET
    hostname = COALESCE(excluded.hostname, agent_instances.hostname),
    pid = COALESCE(excluded.pid, agent_instances.pid),
    heartbeat_interval_ms = COALESCE(excluded.heartbeat_interval_ms, agent_instances.heartbeat_interval_ms),
    last_heartbeat = MAX(agent_instances.last_heartbeat, excluded.last_heartbeat)
`;

/** The process a heartbeat came from. */
interface InstanceBeat {
  instanceId: string;
  hostname: string | undefined;
  pid: number | undefined;
  intervalMs: number | undefined;
}

/**
 * Same-host+pid instances of `agentId` that went silent before `instanceId`
 * was first seen and have missed at least one of their own beats since
 * (one interval plus FRESHNESS_SLACK_MS: beats ride the reporter's 5s flush
 * tick, so live gaps run a few seconds past the interval) - the process
 * `instanceId` replaced. A live twin (another pid namespace:
 * `--network host` replicas, hostNetwork pods) keeps heartbeating, so it is
 * never among them.
 */
const REPLACED_INSTANCES = `
  SELECT old.instance_id FROM agent_instances old
  JOIN agent_instances cur ON cur.agent_id = old.agent_id AND cur.instance_id = ?
  WHERE old.agent_id = ? AND old.instance_id != cur.instance_id
    AND old.hostname = cur.hostname AND old.pid = cur.pid
    AND old.last_heartbeat < cur.first_seen
    AND ? - old.last_heartbeat > COALESCE(old.heartbeat_interval_ms, ?) + ?
`;

/**
 * Record a heartbeat from one process of `agentId`, at the daemon's receive
 * time `now`. From its second heartbeat on, an instance on the same host and
 * pid as an older one that has been silent since before this one was first
 * seen (REPLACED_INSTANCES) has replaced it - a container restarted as pid 1,
 * a reused pid - so the old one's open runs flip to 'interrupted'. A single
 * heartbeat proves nothing (a twin in another pid namespace looks the same),
 * and a row that still heartbeats is never touched. Everything else - a
 * sibling, a restart under a new pid, a forgotten instance coming back - is
 * the sweep's call once an instance goes quiet (sweep.ts).
 */
function recordInstance(db: SqlDatabase, agentId: string, beat: InstanceBeat, now: number): void {
  const seen = db.prepare('SELECT 1 AS k FROM agent_instances WHERE agent_id = ? AND instance_id = ?').get(agentId, beat.instanceId);
  db.prepare(INSTANCE_UPSERT).run(agentId, beat.instanceId, beat.hostname ?? null, beat.pid ?? null, beat.intervalMs ?? null, now, now);
  if (!seen || beat.hostname === undefined || beat.pid === undefined) return;
  const fallback = beat.intervalMs ?? HEARTBEAT_INTERVAL_DEFAULT_MS;
  for (const row of db.prepare(REPLACED_INSTANCES).all(beat.instanceId, agentId, now, fallback, FRESHNESS_SLACK_MS)) {
    interruptInstance(db, agentId, String(row.instance_id), now);
  }
}

/** The reporter instance that started this observation's run (root rows only; older SDKs send none). */
function instanceOf(data: ObservationData): string | null {
  const id = data.attrs?.[OBSERVE_INSTANCE_ATTR];
  return typeof id === 'string' && id !== '' ? id : null; // '' is no instance, like an older SDK
}

const bool = (value: boolean | undefined): number | null => (value === undefined ? null : value ? 1 : 0);

function writeObservation(db: SqlDatabase, now: number, data: ObservationData): void {
  const cut = { truncated: false };
  const input = truncateField(data.input, cut);
  const output = truncateField(data.output, cut);
  db.prepare(OBS_UPSERT).run(
    data.obs_id,
    data.trace_id,
    data.session_id ?? null,
    data.agent_id ?? null,
    data.parent_obs_id ?? null,
    data.kind,
    data.name ?? null,
    data.start,
    data.end ?? null,
    data.status ?? null,
    input,
    output,
    data.model ?? null,
    data.usage_input_tokens ?? null,
    data.usage_output_tokens ?? null,
    data.usage_cached_tokens ?? null,
    data.usage_reasoning_tokens ?? null,
    data.cost_usd ?? null,
    bool(data.cost_partial),
    bool(data.usage_estimated),
    cut.truncated || data.truncated === true ? 1 : 0,
    data.attrs === undefined ? null : JSON.stringify(data.attrs),
    instanceOf(data),
    now
  );
  if (data.session_id !== undefined) {
    db.prepare(SESSION_UPSERT).run(data.session_id, data.agent_id ?? null, data.start, data.end ?? null, now);
  }
}

function writeEvent(db: SqlDatabase, now: number, event: IngestEvent): void {
  switch (event.type) {
    case 'agent.heartbeat': {
      const d = event.data;
      const ts = d.ts ?? now;
      db.prepare(HEARTBEAT_UPSERT).run(
        d.agent_id,
        d.project ?? null,
        d.name ?? null,
        d.version ?? null,
        ts,
        ts,
        JSON.stringify({ heartbeat_interval_ms: d.heartbeat_interval_ms, hostname: d.hostname, pid: d.pid, ...d.meta }),
        now
      );
      // An empty instance_id counts as absent (an older SDK) rather than failing the batch.
      if (d.instance_id) {
        recordInstance(db, d.agent_id, { instanceId: d.instance_id, hostname: d.hostname, pid: d.pid, intervalMs: d.heartbeat_interval_ms }, now);
      }
      return;
    }
    case 'agent.deregister': {
      const d = event.data;
      const ts = d.ts ?? now;
      db.prepare(DEREGISTER_UPSERT).run(d.agent_id, ts, ts, now);
      // A graceful exit with a run still open (SIGINT mid-run): its end never comes.
      // Only the exiting process's runs: a sibling under the same agent_id lives on.
      if (!d.instance_id) interruptOpenObservations(db, d.agent_id, now);
      else interruptInstance(db, d.agent_id, d.instance_id, now);
      return;
    }
    case 'observation':
      writeObservation(db, now, event.data);
      return;
    case 'prompt_use':
      db.prepare(PROMPT_USE_UPSERT).run(event.data.obs_id, event.data.prompt_id, event.data.version ?? null, now);
      return;
    case 'score': {
      const d = event.data;
      db.prepare(SCORE_UPSERT).run(
        d.score_id,
        d.trace_id,
        d.obs_id ?? null,
        d.name,
        d.value ?? null,
        d.source,
        d.comment ?? null,
        d.agent_id ?? null,
        d.ts ?? now,
        now
      );
      return;
    }
  }
}

/**
 * Root-observation metrics of one bucket, per agent - recomputed wholesale
 * (DELETE + INSERT ... SELECT ... GROUP BY), which is what makes a resent
 * batch idempotent: it derives the same rows again rather than adding to them.
 *
 * Besides the additive metrics (runs, errors, cost_usd, input_tokens,
 * output_tokens, latency_ms) each bucket carries two non-additive ones for the
 * Insights charts: `error_rate` (errors / runs) and `p95_latency_ms` (over the
 * bucket's closed roots; no row when none closed). They are stored as values,
 * never summed across buckets. Rows written before they existed are
 * backfilled by `lousho observe rebuild-rollups`.
 */
function recomputeBucket(db: SqlDatabase, granularity: RollupGranularity, bucketStart: number, bucketEnd: number): void {
  db.prepare('DELETE FROM rollups WHERE granularity = ? AND bucket_start = ?').run(granularity, bucketStart);
  db.prepare(
    `WITH roots AS (
       SELECT agent_id, status, cost_usd, usage_input_tokens, usage_output_tokens,
              CASE WHEN "end" IS NULL THEN NULL ELSE "end" - start END AS duration
       FROM observations
       WHERE parent_obs_id IS NULL AND agent_id IS NOT NULL AND start >= ? AND start < ?
     )
     INSERT INTO rollups (bucket_start, granularity, agent_id, metric, value)
     SELECT ?, ?, agent_id, 'runs', COUNT(*) FROM roots GROUP BY agent_id
     UNION ALL SELECT ?, ?, agent_id, 'errors', COALESCE(SUM(status = 'error'), 0) FROM roots GROUP BY agent_id
     UNION ALL SELECT ?, ?, agent_id, 'cost_usd', SUM(COALESCE(cost_usd, 0)) FROM roots GROUP BY agent_id
     UNION ALL SELECT ?, ?, agent_id, 'input_tokens', SUM(COALESCE(usage_input_tokens, 0)) FROM roots GROUP BY agent_id
     UNION ALL SELECT ?, ?, agent_id, 'output_tokens', SUM(COALESCE(usage_output_tokens, 0)) FROM roots GROUP BY agent_id
     UNION ALL SELECT ?, ?, agent_id, 'latency_ms', COALESCE(SUM(duration), 0) FROM roots GROUP BY agent_id
     UNION ALL SELECT ?, ?, agent_id, 'error_rate', CAST(COALESCE(SUM(status = 'error'), 0) AS REAL) / COUNT(*) FROM roots GROUP BY agent_id`
  ).run(
    bucketStart, bucketEnd,
    bucketStart, granularity, bucketStart, granularity, bucketStart, granularity,
    bucketStart, granularity, bucketStart, granularity, bucketStart, granularity,
    bucketStart, granularity
  );
  insertBucketP95(db, granularity, bucketStart, bucketEnd);
}

/** One `p95_latency_ms` row per agent with a closed root in the bucket (the percentile, not the raw durations). */
function insertBucketP95(db: SqlDatabase, granularity: RollupGranularity, bucketStart: number, bucketEnd: number): void {
  const durations = closedRootDurations(db, bucketStart, bucketEnd);
  const insert = db.prepare('INSERT INTO rollups (bucket_start, granularity, agent_id, metric, value) VALUES (?, ?, ?, ?, ?)');
  for (const [agentId, sorted] of durations) {
    insert.run(bucketStart, granularity, agentId, 'p95_latency_ms', percentile(sorted, 95));
  }
}

/** Sorted durations of the finished root runs in `[since, until)`, per agent. */
function closedRootDurations(db: SqlDatabase, since: number, until: number): Map<string, number[]> {
  const durations = new Map<string, number[]>();
  for (const row of db
    .prepare(
      // A run still open (or interrupted) has no latency yet; a zero would drag the percentiles down.
      `SELECT agent_id, "end" - start AS d FROM observations
       WHERE parent_obs_id IS NULL AND agent_id IS NOT NULL AND "end" IS NOT NULL AND start >= ? AND start < ?
       ORDER BY agent_id, d`
    )
    .all(since, until)) {
    const list = durations.get(String(row.agent_id)) ?? [];
    list.push(Number(row.d));
    durations.set(String(row.agent_id), list);
  }
  return durations;
}

/** Every (granularity, bucket) the batch's observations touch. */
function affectedBuckets(batch: readonly IngestEvent[]): Array<{ granularity: RollupGranularity; bucket: number }> {
  const buckets = new Map<string, { granularity: RollupGranularity; bucket: number }>();
  for (const event of batch) {
    if (event.type !== 'observation') continue;
    for (const [granularity, span] of Object.entries(ROLLUP_GRANULARITIES)) {
      const bucket = event.data.start - (event.data.start % span);
      buckets.set(`${granularity}:${bucket}`, { granularity: granularity as RollupGranularity, bucket });
    }
  }
  return [...buckets.values()];
}

export interface IngestResult {
  /** How many events the batch carried. */
  received: number;
}

/**
 * Write one validated envelope batch: all row upserts plus the rollup
 * recompute of every touched bucket, in a single transaction. Idempotent on
 * resend - the same batch produces the same rows, never double counts.
 */
export function ingestBatch(db: SqlDatabase, batch: readonly IngestEvent[], now: number = Date.now()): IngestResult {
  return transaction(db, () => {
    for (const event of batch) writeEvent(db, now, event);
    for (const { granularity, bucket } of affectedBuckets(batch)) {
      recomputeBucket(db, granularity, bucket, bucket + ROLLUP_GRANULARITIES[granularity]);
    }
    return { received: batch.length };
  });
}

/* --------------------------------------------------- monitoring (sweep) */

/**
 * Heartbeat freshness thresholds, in multiples of the agent's own heartbeat
 * interval (default 60s when the reporter did not declare one): `healthy`
 * while the age stays within 2 intervals plus a small slack for scheduling
 * jitter (60s -> ~130s), `stale` until 5 intervals (300s), `down` beyond.
 * `listAgents` derives the same answer the sweep persists, so the read path
 * and the stored status can never disagree.
 */
export const HEARTBEAT_INTERVAL_DEFAULT_MS = 60_000;
const FRESHNESS_STALE_FACTOR = 2;
const FRESHNESS_SLACK_MS = 10_000;
const FRESHNESS_DOWN_FACTOR = 5;

/** `healthy`/`stale`/`down` from a heartbeat age; the sweep's and `listAgents`' shared rule. */
export function freshnessStatus(ageMs: number, intervalMs: number): 'healthy' | 'stale' | 'down' {
  if (ageMs <= FRESHNESS_STALE_FACTOR * intervalMs + FRESHNESS_SLACK_MS) return 'healthy';
  if (ageMs <= FRESHNESS_DOWN_FACTOR * intervalMs) return 'stale';
  return 'down';
}

/** The reporter's `heartbeat_interval_ms` out of a stored `agents.meta` JSON blob. */
export function heartbeatIntervalFromMeta(metaJson: unknown): number | null {
  if (typeof metaJson !== 'string') return null;
  try {
    const meta = JSON.parse(metaJson) as { heartbeat_interval_ms?: unknown };
    return typeof meta.heartbeat_interval_ms === 'number' ? meta.heartbeat_interval_ms : null;
  } catch {
    return null;
  }
}

/** Persist a sweep-computed status. Called only on transitions - a quiet pass writes nothing. */
export function setAgentStatus(db: SqlDatabase, agentId: string, status: string, now: number): void {
  db.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE agent_id = ?').run(status, now, agentId);
}

/**
 * A crashed agent's leftover work: open sessions and still-unfinished
 * observations (`end IS NULL`) flip to 'interrupted' so dead runs do not
 * look alive. Called by the sweep on a transition to 'down' without a prior
 * `agent.deregister`.
 */
export function interruptAgentWork(db: SqlDatabase, agentId: string, now: number): { sessions: number; observations: number } {
  const sessions = db
    .prepare(
      "UPDATE sessions SET status = 'interrupted', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE agent_id = ? AND status = 'active'"
    )
    .run(now, now, agentId);
  // Nobody of this agent heartbeats any more: every instance it had is gone.
  db.prepare('DELETE FROM agent_instances WHERE agent_id = ?').run(agentId);
  return { sessions: Number(sessions.changes), observations: interruptOpenObservations(db, agentId, now) };
}

/**
 * A run the sweep gave up on: `end` still unset, but marked `interrupted`
 * (its process died). It no longer holds a session open. `IS`, not `=`: an
 * open run's status is NULL, and `NOT (... = ...)` on NULL would hide it.
 */
const DEAD_RUN = `(o."end" IS NULL AND o.status IS 'interrupted')`;

/**
 * A session's last activity: its observations' latest end (or start), else
 * the row's own `updated_at`. An interrupted run counts from when it was
 * interrupted (its `updated_at`, which the interrupt writes), so the idle
 * window starts there rather than at the dead run's old start.
 */
const SESSION_LAST_ACTIVITY = `COALESCE(
  (SELECT MAX(CASE WHEN ${DEAD_RUN} THEN MAX(o.start, o.updated_at) ELSE COALESCE(o."end", o.start) END)
     FROM observations o WHERE o.session_id = sessions.session_id),
  sessions.updated_at)`;

/**
 * The idle close: every `active` session with no open observation (`end IS
 * NULL` and not `interrupted`) whose last activity is older than `idleMs`
 * becomes `ended`, with `ended_at` = that last activity (not `now`).
 * `interrupted` sessions are left alone; new activity reopens an ended one on
 * ingest. Returns how many ended.
 */
export function endIdleSessions(db: SqlDatabase, now: number, idleMs: number): number {
  const result = db
    .prepare(
      `UPDATE sessions SET status = 'ended', ended_at = ${SESSION_LAST_ACTIVITY}, updated_at = ?
       WHERE status = 'active'
         AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.session_id = sessions.session_id AND o."end" IS NULL AND NOT ${DEAD_RUN})
         AND ${SESSION_LAST_ACTIVITY} < ?`
    )
    .run(now, now - idleMs);
  return Number(result.changes);
}

/** Flip one instance's open observations to 'interrupted' and forget the instance. */
export function interruptInstance(db: SqlDatabase, agentId: string, instanceId: string, now: number): number {
  const result = db
    .prepare(`UPDATE observations SET status = 'interrupted', updated_at = ? WHERE agent_id = ? AND instance_id = ? AND "end" IS NULL`)
    .run(now, agentId, instanceId);
  db.prepare('DELETE FROM agent_instances WHERE agent_id = ? AND instance_id = ?').run(agentId, instanceId);
  return Number(result.changes);
}

/** Flip `agentId`'s unfinished observations (`end IS NULL`) to 'interrupted'; a later end event still settles them. */
function interruptOpenObservations(db: SqlDatabase, agentId: string, now: number): number {
  const result = db
    .prepare('UPDATE observations SET status = \'interrupted\', updated_at = ? WHERE agent_id = ? AND "end" IS NULL')
    .run(now, agentId);
  return Number(result.changes);
}

/**
 * Recompute every rollup row from `observations` (`lousho observe
 * rebuild-rollups`). The table is a disposable derivation, so repair is just
 * delete + the same per-bucket recompute ingest runs.
 */
export function rebuildRollups(db: SqlDatabase): { buckets: number } {
  return transaction(db, () => {
    db.exec('DELETE FROM rollups');
    const rows = db
      .prepare('SELECT DISTINCT start FROM observations WHERE parent_obs_id IS NULL AND agent_id IS NOT NULL')
      .all();
    let buckets = 0;
    const done = new Set<string>();
    for (const row of rows) {
      const start = Number(row.start);
      for (const [granularity, span] of Object.entries(ROLLUP_GRANULARITIES)) {
        const bucket = start - (start % span);
        const key = `${granularity}:${bucket}`;
        if (done.has(key)) continue;
        done.add(key);
        recomputeBucket(db, granularity as RollupGranularity, bucket, bucket + span);
        buckets++;
      }
    }
    return { buckets };
  });
}

/* --------------------------------------------------------------- retention */

/**
 * The traces retention may drop: every observation finished (`end IS NOT
 * NULL`) and the last one ended before the cutoff. A trace with anything
 * still open is kept whole - pruning runs while agents report, and half a
 * live run must never vanish. Pre-narrowed by `start < cutoff` (a trace that
 * ended before the cutoff started before it) so `observations_start` limits
 * the GROUP BY to old traces. Materialised once per prune into a TEMP table.
 */
const PRUNABLE_TRACES = `
  INSERT INTO temp.prune_traces (trace_id)
  SELECT trace_id FROM observations
  WHERE trace_id IN (SELECT trace_id FROM observations WHERE start < ?)
  GROUP BY trace_id
  HAVING SUM("end" IS NULL) = 0 AND MAX("end") < ?
`;

/** Rows {@link pruneBefore} deleted, per table (`prompt_uses` link rows go with their observations, uncounted). */
export interface PruneResult {
  observations: number;
  scores: number;
  sessions: number;
}

/**
 * Retention: delete whole finished traces whose last observation ended before
 * `cutoffMs` - their observations, `prompt_uses` links and scores - plus
 * scores older than the cutoff whose trace has no observations left, and
 * non-`active` sessions that ended (or started) before the cutoff and that no
 * observation still references. One transaction. Never touches `rollups`
 * (Insights keep the pruned days), `prompts`, `hub_entries`, `agents`,
 * `tokens` or `agent_instances`, and never VACUUMs (only the CLI does).
 */
export function pruneBefore(db: SqlDatabase, cutoffMs: number): PruneResult {
  return transaction(db, () => {
    // TEMP DDL is transactional: a rollback drops it too.
    db.exec('CREATE TEMP TABLE IF NOT EXISTS prune_traces (trace_id TEXT PRIMARY KEY)');
    db.exec('DELETE FROM temp.prune_traces');
    db.prepare(PRUNABLE_TRACES).run(cutoffMs, cutoffMs);
    // Children before observations: the link rows are found through them.
    db.prepare(
      'DELETE FROM prompt_uses WHERE obs_id IN (SELECT obs_id FROM observations WHERE trace_id IN (SELECT trace_id FROM temp.prune_traces))'
    ).run();
    const traceScores = db.prepare('DELETE FROM scores WHERE trace_id IN (SELECT trace_id FROM temp.prune_traces)').run();
    const observations = db.prepare('DELETE FROM observations WHERE trace_id IN (SELECT trace_id FROM temp.prune_traces)').run();
    db.exec('DROP TABLE temp.prune_traces');
    const orphanScores = db
      .prepare('DELETE FROM scores WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.trace_id = scores.trace_id)')
      .run(cutoffMs);
    const sessions = db
      .prepare(
        `DELETE FROM sessions WHERE status != 'active' AND COALESCE(ended_at, started_at) < ?
         AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.session_id = sessions.session_id)`
      )
      .run(cutoffMs);
    return {
      observations: Number(observations.changes),
      scores: Number(traceScores.changes) + Number(orphanScores.changes),
      sessions: Number(sessions.changes),
    };
  });
}

/* ------------------------------------------------------------------ tokens */

/** `lso_` = lousho observe; 24 random bytes is 32 base64url characters. */
const TOKEN_PREFIX = 'lso_';

function hashTokenKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Create a daemon token for `project` and return the key ONCE - only its
 * sha256 lands in `tokens`, so the plaintext cannot be recovered later.
 */
export function createToken(db: SqlDatabase, project: string | undefined, now: number = Date.now()): { tokenId: string; key: string } {
  const tokenId = randomBytes(8).toString('hex');
  const key = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
  db.prepare('INSERT INTO tokens (token_id, project, key_hash, created_at) VALUES (?, ?, ?, ?)').run(
    tokenId,
    project ?? null,
    hashTokenKey(key),
    now
  );
  return { tokenId, key };
}

/** Whether `key` names a live token. A non-`lso_` value is cheaply rejected before the lookup. */
export function verifyToken(db: SqlDatabase, key: string | undefined): boolean {
  if (!key || !key.startsWith(TOKEN_PREFIX)) return false;
  const row = db.prepare('SELECT token_id FROM tokens WHERE key_hash = ? AND revoked_at IS NULL').get(hashTokenKey(key));
  return row !== undefined;
}

/** Whether any live token exists (used by `status` and the auth-warning). */
export function hasTokens(db: SqlDatabase): boolean {
  return db.prepare('SELECT token_id FROM tokens WHERE revoked_at IS NULL LIMIT 1').get() !== undefined;
}

/* -------------------------------------------------------------- read path */

/** Row counts for `lousho observe status` (and the daemon's `/api/v1/status`). */
export function observeCounts(db: SqlDatabase): Record<string, number> {
  const one = (sql: string): number => Number(db.prepare(sql).get()?.n ?? 0);
  return {
    agents: one('SELECT COUNT(*) AS n FROM agents'),
    sessions: one('SELECT COUNT(*) AS n FROM sessions'),
    observations: one('SELECT COUNT(*) AS n FROM observations'),
    traces: one('SELECT COUNT(DISTINCT trace_id) AS n FROM observations'),
    scores: one('SELECT COUNT(*) AS n FROM scores'),
    tokens: one('SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NULL'),
  };
}

/** The trace list's sort keys: trace start, `end - start`, input + output tokens, or `cost_usd`. */
export const TRACE_SORTS = ['start', 'duration', 'tokens', 'cost'] as const;
export type TraceSort = (typeof TRACE_SORTS)[number];

export interface TraceFilter {
  agent_id?: string;
  project?: string;
  status?: string;
  session_id?: string;
  /** Observation start >= `since` (inclusive). */
  since?: number;
  /** Observation start <= `until` (inclusive). */
  until?: number;
  /** Trace start >= `from` (ms epoch; the window is half-open `[from, to)`). */
  from?: number;
  /** Trace start < `to` (ms epoch). */
  to?: number;
  /** Case-insensitive (ASCII) substring of the root observation's name, input or output. */
  q?: string;
  /** Trace `end - start` >= this many milliseconds. */
  min_duration_ms?: number;
  /** Traces where any observation used this model. */
  model?: string;
  /** Traces where any observation is linked (`prompt_uses`) to this registry prompt - any version, or just `version`. */
  prompt?: { name: string; version?: number };
  /** Default `start`. Ties break on `trace_id` in the same direction. */
  sort?: TraceSort;
  /** Default `desc`. */
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface TraceRow {
  trace_id: string;
  name: string | null;
  agent_id: string | null;
  session_id: string | null;
  start: number;
  end: number;
  status: string;
  observations: number;
  generations: number;
  tools: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  /** The agent's registered name (from its heartbeat), or null. */
  agent_name: string | null;
  /** The first generation's model (by start), or null. */
  model: string | null;
  /** The first error observation's `attrs.error` (by start), or null. */
  error_message: string | null;
  /** The first 200 characters of the root observation's input, or null. */
  input_preview: string | null;
  /** The first 200 characters of the root observation's output, or null. */
  output_preview: string | null;
}

const nullableText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function traceRow(row: Record<string, unknown>): TraceRow {
  const rootStatus = row.root_status as string | null;
  const errors = Number(row.error_count ?? 0);
  return {
    trace_id: String(row.trace_id),
    name: (row.name as string | null) ?? null,
    agent_id: (row.agent_id as string | null) ?? null,
    session_id: (row.session_id as string | null) ?? null,
    start: Number(row.start),
    end: Number(row.end),
    status: rootStatus ?? (errors > 0 ? 'error' : 'ok'),
    observations: Number(row.observations),
    generations: Number(row.generations),
    tools: Number(row.tools),
    errors,
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    cost_usd: Number(row.cost_usd),
    agent_name: nullableText(row.agent_name),
    model: nullableText(row.model),
    error_message: nullableText(row.error_message),
    input_preview: nullableText(row.input_preview),
    output_preview: nullableText(row.output_preview),
  };
}

/**
 * A trace's status is its root observation's; a root still open (`end` NULL,
 * no verdict yet - the reporter's eager start) is 'running'.
 */
const ROOT_STATUS =
  `(SELECT CASE WHEN r.status IS NULL AND r."end" IS NULL THEN 'running' ELSE r.status END ` +
  `FROM observations r WHERE r.trace_id = o.trace_id AND r.parent_obs_id IS NULL LIMIT 1)`;

type SqlArg = (value: string | number | null) => string;

/** The root observation of the grouped trace `o.trace_id`, as a correlated-subquery source. */
const ROOT_OF = `observations r WHERE r.trace_id = o.trace_id AND r.parent_obs_id IS NULL`;

/** `value` as a LIKE pattern matching it as a literal substring (paired with `ESCAPE '\'`). */
const likeContains = (value: string): string => `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** `AND EXISTS` an observation of the trace linked to the prompt `name` (at `version`, when given). */
function promptUseExists(prompt: { name: string; version?: number }, arg: SqlArg): string {
  // `arg` binds positionally, so call it in SQL text order: name, then version.
  const name = arg(prompt.name);
  const version = prompt.version === undefined ? '' : ` AND p.version = ${arg(prompt.version)}`;
  return (
    ` AND EXISTS (SELECT 1 FROM observations u JOIN prompt_uses pu ON pu.obs_id = u.obs_id` +
    ` JOIN prompts p ON p.prompt_id = pu.prompt_id` +
    ` WHERE u.trace_id = o.trace_id AND p.name = ${name}${version})`
  );
}

/**
 * The window/duration/model/prompt/search filters. They judge the whole trace, so
 * they sit in HAVING; `from`/`to` bound the trace start, half-open.
 */
function traceHavingExtras(filter: TraceFilter, arg: SqlArg): string {
  let having = '';
  if (filter.from !== undefined) having += ` AND MIN(o.start) >= ${arg(filter.from)}`;
  if (filter.to !== undefined) having += ` AND MIN(o.start) < ${arg(filter.to)}`;
  if (filter.min_duration_ms !== undefined) {
    having += ` AND MAX(COALESCE(o."end", o.start)) - MIN(o.start) >= ${arg(filter.min_duration_ms)}`;
  }
  if (filter.model !== undefined) {
    having += ` AND EXISTS (SELECT 1 FROM observations m WHERE m.trace_id = o.trace_id AND m.model = ${arg(filter.model)})`;
  }
  if (filter.prompt !== undefined) having += promptUseExists(filter.prompt, arg);
  if (filter.q) {
    const like = likeContains(filter.q);
    const col = (name: string): string => `r.${name} LIKE ${arg(like)} ESCAPE '\\'`;
    having += ` AND EXISTS (SELECT 1 FROM ${ROOT_OF} AND (${col('name')} OR ${col('input')} OR ${col('output')}))`;
  }
  return having;
}

/** The trace list's WHERE/HAVING pieces, shared by the page query and its total. */
function traceFilterWhere(filter: TraceFilter): { where: string; having: string; params: (string | number | null)[] } {
  const params: (string | number | null)[] = [];
  let where = '1 = 1';
  const arg: SqlArg = (value) => {
    params.push(value);
    return '?';
  };
  // A missing bound means "no filter"; keep the parameter count stable by binding NULL twice.
  where += ` AND (${arg(filter.agent_id ?? null)} IS NULL OR o.agent_id = ${arg(filter.agent_id ?? null)})`;
  where += ` AND (${arg(filter.session_id ?? null)} IS NULL OR o.session_id = ${arg(filter.session_id ?? null)})`;
  where += ` AND (${arg(filter.since ?? null)} IS NULL OR o.start >= ${arg(filter.since ?? null)})`;
  where += ` AND (${arg(filter.until ?? null)} IS NULL OR o.start <= ${arg(filter.until ?? null)})`;
  if (filter.project !== undefined) {
    where += ` AND o.agent_id IN (SELECT agent_id FROM agents WHERE project = ${arg(filter.project)})`;
  }
  const status = arg(filter.status ?? null);
  const status2 = arg(filter.status ?? null);
  // Trace status is the root observation's; a trace with no root yet is 'error' when any child failed.
  // Written without select aliases so the same clause fits the bare `SELECT o.trace_id` total subquery.
  const having =
    `(${status} IS NULL OR COALESCE(` +
    `${ROOT_STATUS}, ` +
    `CASE WHEN SUM(o.status = 'error') > 0 THEN 'error' ELSE 'ok' END) = ${status2})` +
    traceHavingExtras(filter, arg);
  return { where, having, params };
}

/** Per-trace aggregates; {@link listTraces} splices its WHERE in after the FROM. */
const TRACE_SELECT = `
  SELECT o.trace_id,
    MIN(o.start) AS start,
    MAX(COALESCE(o."end", o.start)) AS "end",
    COUNT(*) AS observations,
    SUM(o.kind = 'generation') AS generations,
    SUM(o.kind = 'tool') AS tools,
    SUM(o.status = 'error') AS error_count,
    SUM(COALESCE(o.usage_input_tokens, 0)) AS input_tokens,
    SUM(COALESCE(o.usage_output_tokens, 0)) AS output_tokens,
    SUM(COALESCE(o.cost_usd, 0)) AS cost_usd,
    MAX(o.agent_id) AS agent_id,
    MAX(o.session_id) AS session_id,
    (SELECT r.name FROM ${ROOT_OF} LIMIT 1) AS name,
    (SELECT substr(r.input, 1, 200) FROM ${ROOT_OF} LIMIT 1) AS input_preview,
    (SELECT substr(r.output, 1, 200) FROM ${ROOT_OF} LIMIT 1) AS output_preview,
    ${ROOT_STATUS} AS root_status
  FROM observations o
`;

/**
 * The page's per-row lookups over the grouped trace `t`: the agent's name,
 * the first generation's model, and the first error's `attrs.error` (an
 * error observation without one is skipped, so a bare failed root does not
 * hide its failing child's message).
 */
const TRACE_EXTRAS = `
  (SELECT a.name FROM agents a WHERE a.agent_id = t.agent_id) AS agent_name,
  (SELECT m.model FROM observations m WHERE m.trace_id = t.trace_id AND m.kind = 'generation' AND m.model IS NOT NULL
    ORDER BY m.start, m.obs_id LIMIT 1) AS model,
  (SELECT json_extract(e.attrs, '$.error') FROM observations e
    WHERE e.trace_id = t.trace_id AND e.status = 'error' AND json_valid(e.attrs) AND json_extract(e.attrs, '$.error') IS NOT NULL
    ORDER BY e.start, e.obs_id LIMIT 1) AS error_message`;

/** Whitelisted ORDER BY expressions over the grouped trace `t` (never request text). */
const TRACE_SORT_SQL: Record<TraceSort, string> = {
  start: 't.start',
  duration: '(t."end" - t.start)',
  tokens: '(t.input_tokens + t.output_tokens)',
  cost: 't.cost_usd',
};

export function listTraces(db: SqlDatabase, filter: TraceFilter): { traces: TraceRow[]; total: number } {
  const { where, having, params } = traceFilterWhere(filter);
  const grouped = `FROM observations o WHERE ${where} GROUP BY o.trace_id HAVING ${having}`;
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM (SELECT o.trace_id ${grouped})`).get(...params)?.n ?? 0);
  const dir = filter.order === 'asc' ? 'ASC' : 'DESC';
  const sortBy = TRACE_SORT_SQL[filter.sort ?? 'start'] ?? TRACE_SORT_SQL.start;
  const page = `${TRACE_SELECT.replace('FROM observations o', `FROM observations o WHERE ${where}`)} GROUP BY o.trace_id HAVING ${having}`;
  const rows = db
    .prepare(`SELECT t.*, ${TRACE_EXTRAS} FROM (${page}) t ORDER BY ${sortBy} ${dir}, t.trace_id ${dir} LIMIT ? OFFSET ?`)
    .all(...params, filter.limit, filter.offset);
  return { traces: rows.map(traceRow), total };
}

/** One observation (span) as the daemon stores and serves it (`GET /api/v1/traces/:id`'s `observations`). */
export interface ObservationRow {
  /** The observation (span) id. */
  obs_id: string;
  /** The trace it belongs to. */
  trace_id: string;
  /** The reporting session, when known. */
  session_id: string | null;
  /** The agent that reported it. */
  agent_id: string | null;
  /** The parent observation; `null` for a root. */
  parent_obs_id: string | null;
  /** `span`, `generation`, `tool`, ... */
  kind: string;
  /** The span name (e.g. `invoke_agent <agent>`). */
  name: string | null;
  /** Start, epoch ms. */
  start: number;
  /** End, epoch ms; `null` while open. */
  end: number | null;
  /** `ok`, `error`, `interrupted`, ...; `null` while open. */
  status: string | null;
  /** Captured input text, when content capture is on. */
  input: string | null;
  /** Captured output text, when content capture is on. */
  output: string | null;
  /** The model a generation called. */
  model: string | null;
  /** Input tokens of a generation. */
  usage_input_tokens: number | null;
  /** Output tokens of a generation. */
  usage_output_tokens: number | null;
  /** Cached input tokens of a generation. */
  usage_cached_tokens: number | null;
  /** Reasoning tokens of a generation. */
  usage_reasoning_tokens: number | null;
  /** Cost in USD, when priced. */
  cost_usd: number | null;
  /** The cost misses some priced parts. */
  cost_partial: boolean | null;
  /** The token counts are estimates. */
  usage_estimated: boolean | null;
  /** Some content was cut to fit the size caps. */
  truncated: boolean;
  /** The remaining span attributes. */
  attrs: Record<string, unknown> | null;
}

function observationRow(row: Record<string, unknown>): ObservationRow {
  let attrs: Record<string, unknown> | null = null;
  if (typeof row.attrs === 'string') {
    try {
      attrs = JSON.parse(row.attrs) as Record<string, unknown>;
    } catch {
      attrs = null;
    }
  }
  const flag = (value: unknown): boolean | null => (value === null || value === undefined ? null : Number(value) !== 0);
  return {
    obs_id: String(row.obs_id),
    trace_id: String(row.trace_id),
    session_id: (row.session_id as string | null) ?? null,
    agent_id: (row.agent_id as string | null) ?? null,
    parent_obs_id: (row.parent_obs_id as string | null) ?? null,
    kind: String(row.kind),
    name: (row.name as string | null) ?? null,
    start: Number(row.start),
    end: row.end === null || row.end === undefined ? null : Number(row.end),
    status: (row.status as string | null) ?? null,
    input: (row.input as string | null) ?? null,
    output: (row.output as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    usage_input_tokens: row.usage_input_tokens === null ? null : Number(row.usage_input_tokens),
    usage_output_tokens: row.usage_output_tokens === null ? null : Number(row.usage_output_tokens),
    usage_cached_tokens: row.usage_cached_tokens === null ? null : Number(row.usage_cached_tokens),
    usage_reasoning_tokens: row.usage_reasoning_tokens === null ? null : Number(row.usage_reasoning_tokens),
    cost_usd: row.cost_usd === null ? null : Number(row.cost_usd),
    cost_partial: flag(row.cost_partial),
    usage_estimated: flag(row.usage_estimated),
    truncated: Number(row.truncated ?? 0) !== 0,
    attrs,
  };
}

export interface TraceDetail {
  trace_id: string;
  observations: ObservationRow[];
  scores: ScoreRow[];
}

/** One trace's observation tree (flat rows; the client nests by `parent_obs_id`) plus its scores. */
export function traceDetail(db: SqlDatabase, traceId: string): TraceDetail | undefined {
  const observations = db
    .prepare('SELECT * FROM observations WHERE trace_id = ? ORDER BY start ASC')
    .all(traceId)
    .map(observationRow);
  if (observations.length === 0) return undefined;
  const scores = listScores(db, { trace_id: traceId, limit: 1000 }).scores;
  return { trace_id: traceId, observations, scores };
}

export interface ScoreRow {
  score_id: string;
  trace_id: string;
  obs_id: string | null;
  name: string;
  value: number | null;
  source: string;
  comment: string | null;
  agent_id: string | null;
  created_at: number;
}

export interface ScoreFilter {
  trace_id?: string;
  /** Exact score name (`<evalName>/<assertionName>`); `eval` is the prefix version. */
  name?: string;
  /** Prefix match on the eval name: the score's own name or `<eval>/...`. */
  eval?: string;
  agent_id?: string;
  source?: string;
  /** created_at bounds, milliseconds since the epoch (`since` inclusive, `until` exclusive). */
  since?: number;
  until?: number;
  limit: number;
}

/** The WHERE fragment every scores read shares; `params` fills in parallel. */
function scoreFilterWhere(filter: ScoreFilter): { where: string; params: (string | number)[] } {
  let where = '1 = 1';
  const params: (string | number)[] = [];
  if (filter.trace_id !== undefined) {
    where += ' AND trace_id = ?';
    params.push(filter.trace_id);
  }
  if (filter.name !== undefined) {
    where += ' AND name = ?';
    params.push(filter.name);
  }
  if (filter.eval !== undefined) {
    // Score names are '<evalName>/<assertionName>'; the eval's family is the exact name plus the prefix.
    where += ' AND (name = ? OR name LIKE ? ESCAPE \'\\\')';
    params.push(filter.eval, `${filter.eval.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`);
  }
  if (filter.agent_id !== undefined) {
    where += ' AND agent_id = ?';
    params.push(filter.agent_id);
  }
  if (filter.source !== undefined) {
    where += ' AND source = ?';
    params.push(filter.source);
  }
  if (filter.since !== undefined) {
    where += ' AND created_at >= ?';
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    where += ' AND created_at < ?';
    params.push(filter.until);
  }
  return { where, params };
}

export function listScores(db: SqlDatabase, filter: ScoreFilter): { scores: ScoreRow[] } {
  const { where, params } = scoreFilterWhere(filter);
  const rows = db
    .prepare(`SELECT * FROM scores WHERE ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, filter.limit)
    .map((row) => ({
      score_id: String(row.score_id),
      trace_id: String(row.trace_id),
      obs_id: (row.obs_id as string | null) ?? null,
      name: String(row.name),
      value: row.value === null ? null : Number(row.value),
      source: String(row.source),
      comment: (row.comment as string | null) ?? null,
      agent_id: (row.agent_id as string | null) ?? null,
      created_at: Number(row.created_at),
    }));
  return { scores: rows };
}

/** Pass-rate aggregate for one eval name (the score name's part before the first '/'), for the Studio eval-history view. */
export interface ScorePassRate {
  /** The eval name the group aggregates. */
  name: string;
  /** Score rows in the group. */
  count: number;
  /** Rows that passed: an assertion row passes when it carries no failure comment (or a perfect 1, e.g. a skipped gate). */
  passed: number;
  /** `passed / count`. */
  pass_rate: number;
  /** Mean `value` across the group's rows (null when every value is NULL). */
  avg_value: number | null;
  /** Newest row's `created_at`. */
  last_ts: number;
}

/**
 * Pass-rate per eval name, for the eval-history view: score rows group by
 * their `<evalName>` prefix and each group reports its count, pass count and
 * rate, mean value and last-seen time. A row counts as passed when it has no
 * failure comment (assertions always write a message when they fail) or its
 * value is exactly 1 (a perfect score, which covers skipped gates).
 */
export function scorePassRates(
  db: SqlDatabase,
  filter: { eval?: string; agent_id?: string; source?: string; since?: number; until?: number }
): ScorePassRate[] {
  const { where, params } = scoreFilterWhere({ ...filter, limit: 0 });
  const rows = db
    .prepare(
      `SELECT
         CASE WHEN instr(name, '/') > 0 THEN substr(name, 1, instr(name, '/') - 1) ELSE name END AS eval_name,
         COUNT(*) AS n,
         SUM(CASE WHEN comment IS NULL OR comment = '' OR value = 1 THEN 1 ELSE 0 END) AS passed,
         AVG(value) AS avg_value,
         MAX(created_at) AS last_ts
       FROM scores WHERE ${where}
       GROUP BY eval_name
       ORDER BY last_ts DESC`
    )
    .all(...params);
  return rows.map((row) => {
    const count = Number(row.n);
    const passed = Number(row.passed ?? 0);
    return {
      name: String(row.eval_name),
      count,
      passed,
      pass_rate: count > 0 ? passed / count : 0,
      avg_value: row.avg_value === null || row.avg_value === undefined ? null : Number(row.avg_value),
      last_ts: Number(row.last_ts),
    };
  });
}

/** The reporter-supplied identity and drop count out of a stored `agents.meta` JSON blob; each `null` when absent or malformed. */
function metaFieldsOf(metaJson: unknown): { hostname: string | null; pid: number | null; dropped: number | null } {
  const none = { hostname: null, pid: null, dropped: null };
  if (typeof metaJson !== 'string') return none;
  try {
    const meta = JSON.parse(metaJson) as { hostname?: unknown; pid?: unknown; dropped?: unknown };
    return {
      hostname: typeof meta.hostname === 'string' ? meta.hostname : null,
      pid: typeof meta.pid === 'number' ? meta.pid : null,
      dropped: typeof meta.dropped === 'number' ? meta.dropped : null,
    };
  } catch {
    return none; // malformed meta: freshness still derives from defaults
  }
}

export interface AgentRow {
  agent_id: string;
  project: string | null;
  name: string | null;
  version: string | null;
  first_seen: number;
  last_heartbeat: number | null;
  status: string;
  heartbeat_age_ms: number | null;
  heartbeat_interval_ms: number | null;
  hostname: string | null;
  pid: number | null;
  /** Cumulative telemetry events the agent's reporter dropped, from its latest heartbeat; `null` from an older SDK. */
  dropped: number | null;
}

/**
 * Fleet registry rows plus read-time freshness. The sweep (sweep.ts) rewrites
 * `agents.status` on its interval; the read path derives the same value with
 * the same {@link freshnessStatus} rule, so a row answers correctly between
 * sweeps too: stored 'stopped' wins (a graceful exit), else the row ages
 * `healthy` -> `stale` -> `down` against its heartbeat interval.
 */
export function listAgents(db: SqlDatabase, now: number = Date.now()): AgentRow[] {
  const rows = db.prepare('SELECT * FROM agents ORDER BY COALESCE(last_heartbeat, first_seen) DESC').all();
  return rows.map((row) => {
    const { hostname, pid, dropped } = metaFieldsOf(row.meta);
    const interval = heartbeatIntervalFromMeta(row.meta);
    const lastHeartbeat = row.last_heartbeat === null ? null : Number(row.last_heartbeat);
    const age = lastHeartbeat === null ? null : Math.max(0, now - lastHeartbeat);
    const step = interval ?? HEARTBEAT_INTERVAL_DEFAULT_MS;
    const stored = String(row.status ?? 'healthy');
    const status = stored === 'stopped' ? 'stopped' : age === null ? stored : freshnessStatus(age, step);
    return {
      agent_id: String(row.agent_id),
      project: (row.project as string | null) ?? null,
      name: (row.name as string | null) ?? null,
      version: (row.version as string | null) ?? null,
      first_seen: Number(row.first_seen),
      last_heartbeat: lastHeartbeat,
      status,
      heartbeat_age_ms: age,
      heartbeat_interval_ms: interval,
      hostname,
      pid,
      dropped,
    };
  });
}

export interface AgentInsights {
  agent_id: string;
  project: string | null;
  name: string | null;
  runs: number;
  runs_per_day: number;
  errors: number;
  error_rate: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
}

/**
 * Days the agent could have run inside the window: from the later of the
 * window start and its first sighting (the window start when the agent row is
 * missing) to the window end, never under one. An agent born today is not
 * averaged over the six empty days before it existed.
 */
function activeDays(windowMs: { since: number; until: number }, firstSeen: number | undefined): number {
  const from = Math.max(windowMs.since, firstSeen ?? windowMs.since);
  return Math.max(1, Math.ceil((windowMs.until - from) / DAY_MS));
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/**
 * Insights aggregates per agent over `[since, until)`: run/error/cost/token
 * figures come from `rollups` (the dashboard never scans raw rows for them);
 * latency percentiles are the sanctioned drilldown on `observations`.
 */
export function insightsAgents(db: SqlDatabase, windowMs: { since: number; until: number }): AgentInsights[] {
  // Aggregate the day-granularity buckets inside the window. Only the additive
  // metrics: p95_latency_ms / error_rate rows are per-bucket values, not sums.
  const sinceDay = windowMs.since - (windowMs.since % DAY_MS);
  const metrics = new Map<string, Map<string, number>>();
  for (const row of db
    .prepare(
      `SELECT agent_id, metric, SUM(value) AS v FROM rollups
       WHERE granularity = 'day' AND bucket_start >= ? AND bucket_start < ?
         AND metric IN ('runs', 'errors', 'cost_usd', 'input_tokens', 'output_tokens')
       GROUP BY agent_id, metric`
    )
    .all(sinceDay, windowMs.until)) {
    const agentId = String(row.agent_id);
    const m = metrics.get(agentId) ?? new Map<string, number>();
    m.set(String(row.metric), Number(row.v));
    metrics.set(agentId, m);
  }
  const durations = closedRootDurations(db, windowMs.since, windowMs.until);
  const names = new Map<string, { project: string | null; name: string | null; first_seen: number }>();
  for (const agent of listAgents(db)) names.set(agent.agent_id, { project: agent.project, name: agent.name, first_seen: agent.first_seen });
  const agentIds = new Set([...metrics.keys(), ...durations.keys()]);
  return [...agentIds].sort().map((agentId) => {
    const m = metrics.get(agentId) ?? new Map<string, number>();
    const runs = m.get('runs') ?? 0;
    const errors = m.get('errors') ?? 0;
    const sorted = durations.get(agentId) ?? [];
    return {
      agent_id: agentId,
      project: names.get(agentId)?.project ?? null,
      name: names.get(agentId)?.name ?? null,
      runs,
      runs_per_day: runs / activeDays(windowMs, names.get(agentId)?.first_seen),
      errors,
      error_rate: runs > 0 ? errors / runs : 0,
      cost_usd: m.get('cost_usd') ?? 0,
      input_tokens: m.get('input_tokens') ?? 0,
      output_tokens: m.get('output_tokens') ?? 0,
      p50_latency_ms: percentile(sorted, 50),
      p95_latency_ms: percentile(sorted, 95),
    };
  });
}

export interface RollupRow {
  bucket_start: number;
  granularity: string;
  agent_id: string;
  metric: string;
  value: number;
}

/** Rollup time series for the Insights charts. */
export function rollupSeries(
  db: SqlDatabase,
  filter: { granularity?: RollupGranularity; agent_id?: string; since?: number; until?: number }
): RollupRow[] {
  let where = '1 = 1';
  const params: (string | number)[] = [];
  if (filter.granularity !== undefined) {
    where += ' AND granularity = ?';
    params.push(filter.granularity);
  }
  if (filter.agent_id !== undefined) {
    where += ' AND agent_id = ?';
    params.push(filter.agent_id);
  }
  if (filter.since !== undefined) {
    where += ' AND bucket_start >= ?';
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    where += ' AND bucket_start < ?';
    params.push(filter.until);
  }
  return db
    .prepare(`SELECT * FROM rollups WHERE ${where} ORDER BY bucket_start, agent_id, metric`)
    .all(...params)
    .map((row) => ({
      bucket_start: Number(row.bucket_start),
      granularity: String(row.granularity),
      agent_id: String(row.agent_id),
      metric: String(row.metric),
      value: Number(row.value),
    }));
}

export interface SessionFilter {
  agent_id?: string;
  status?: string;
  /** Session start >= `from` (ms epoch; the window is half-open `[from, to)`). */
  from?: number;
  /** Session start < `to`. */
  to?: number;
  limit: number;
  offset: number;
}

/** One conversation thread: the session row plus its runs' totals. */
export interface SessionRow {
  session_id: string;
  agent_id: string | null;
  /** The agent's registered name (from its heartbeat), or null. */
  agent_name: string | null;
  status: string;
  started_at: number;
  ended_at: number | null;
  /** Distinct traces among the session's observations. */
  traces: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  /** The first 200 characters of the latest-starting trace's root input, or null. */
  last_input_preview: string | null;
}

const SESSION_SELECT = `
  SELECT s.session_id, s.agent_id, s.status, s.started_at, s.ended_at,
    (SELECT a.name FROM agents a WHERE a.agent_id = s.agent_id) AS agent_name,
    (SELECT COUNT(DISTINCT o.trace_id) FROM observations o WHERE o.session_id = s.session_id) AS traces,
    (SELECT COALESCE(SUM(o.usage_input_tokens), 0) FROM observations o WHERE o.session_id = s.session_id) AS input_tokens,
    (SELECT COALESCE(SUM(o.usage_output_tokens), 0) FROM observations o WHERE o.session_id = s.session_id) AS output_tokens,
    (SELECT COALESCE(SUM(o.cost_usd), 0) FROM observations o WHERE o.session_id = s.session_id) AS cost_usd,
    (SELECT substr(r.input, 1, 200) FROM observations r
      WHERE r.session_id = s.session_id AND r.parent_obs_id IS NULL
      ORDER BY r.start DESC, r.obs_id DESC LIMIT 1) AS last_input_preview
  FROM sessions s
`;

function sessionRow(row: Record<string, unknown>): SessionRow {
  return {
    session_id: String(row.session_id),
    agent_id: nullableText(row.agent_id),
    agent_name: nullableText(row.agent_name),
    status: String(row.status),
    started_at: Number(row.started_at),
    ended_at: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    traces: Number(row.traces),
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    cost_usd: Number(row.cost_usd),
    last_input_preview: nullableText(row.last_input_preview),
  };
}

/** Sessions, newest first (`started_at` desc, `session_id` tiebreak), with the total before paging. */
export function listSessions(db: SqlDatabase, filter: SessionFilter): { sessions: SessionRow[]; total: number } {
  const params: (string | number)[] = [];
  let where = '1 = 1';
  const add = (clause: string, value: string | number | undefined): void => {
    if (value === undefined) return;
    where += ` AND ${clause}`;
    params.push(value);
  };
  add('s.agent_id = ?', filter.agent_id);
  add('s.status = ?', filter.status);
  add('s.started_at >= ?', filter.from);
  add('s.started_at < ?', filter.to);
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM sessions s WHERE ${where}`).get(...params)?.n ?? 0);
  const rows = db
    .prepare(`${SESSION_SELECT} WHERE ${where} ORDER BY s.started_at DESC, s.session_id DESC LIMIT ? OFFSET ?`)
    .all(...params, filter.limit, filter.offset);
  return { sessions: rows.map(sessionRow), total };
}

/** One session by id, or undefined. */
export function getSession(db: SqlDatabase, sessionId: string): SessionRow | undefined {
  const row = db.prepare(`${SESSION_SELECT} WHERE s.session_id = ?`).get(sessionId);
  return row ? sessionRow(row) : undefined;
}
