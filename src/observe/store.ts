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

/** `work` in one write transaction (`BEGIN IMMEDIATE`), rolled back when it throws. */
export function transaction<T>(db: SqlDatabase, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
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

/** A session row is derived from whatever observations carry its id; there is no session event in the envelope. */
const SESSION_UPSERT = `
  INSERT INTO sessions (session_id, agent_id, started_at, ended_at, status, updated_at)
  VALUES (?, ?, ?, ?, 'active', ?)
  ON CONFLICT(session_id) DO UPDATE SET
    agent_id = COALESCE(excluded.agent_id, sessions.agent_id),
    started_at = MIN(sessions.started_at, excluded.started_at),
    ended_at = CASE
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
  INSERT INTO agent_instances (agent_id, instance_id, first_seen, last_heartbeat)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(agent_id, instance_id) DO UPDATE SET
    last_heartbeat = MAX(agent_instances.last_heartbeat, excluded.last_heartbeat)
`;

/**
 * A heartbeat from `instanceId`. The first one from an instance means the
 * agent (re)started in a new process: the open runs of its earlier instances
 * can never finish - a supervisor restart or a re-run comes back well inside
 * the window the sweep needs to call the agent down - so they flip to
 * 'interrupted'. A sibling process starting up does the same to a live
 * sibling's runs; their end event settles them again.
 */
function recordInstance(db: SqlDatabase, agentId: string, instanceId: string, ts: number, now: number): void {
  const known = db.prepare('SELECT 1 AS k FROM agent_instances WHERE agent_id = ? AND instance_id = ?').get(agentId, instanceId);
  if (!known) {
    db.prepare(
      `UPDATE observations SET status = 'interrupted', updated_at = ?
       WHERE agent_id = ? AND "end" IS NULL AND instance_id IS NOT NULL AND instance_id != ?`
    ).run(now, agentId, instanceId);
  }
  db.prepare(INSTANCE_UPSERT).run(agentId, instanceId, ts, ts);
}

/** The reporter instance that started this observation's run (root rows only; older SDKs send none). */
function instanceOf(data: ObservationData): string | null {
  const id = data.attrs?.[OBSERVE_INSTANCE_ATTR];
  return typeof id === 'string' ? id : null;
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
      if (d.instance_id !== undefined) recordInstance(db, d.agent_id, d.instance_id, ts, now);
      return;
    }
    case 'agent.deregister': {
      const d = event.data;
      const ts = d.ts ?? now;
      db.prepare(DEREGISTER_UPSERT).run(d.agent_id, ts, ts, now);
      // A graceful exit with a run still open (SIGINT mid-run): its end never comes.
      // Only the exiting process's runs: a sibling under the same agent_id lives on.
      if (d.instance_id === undefined) interruptOpenObservations(db, d.agent_id, now);
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
     UNION ALL SELECT ?, ?, agent_id, 'latency_ms', COALESCE(SUM(duration), 0) FROM roots GROUP BY agent_id`
  ).run(
    bucketStart, bucketEnd,
    bucketStart, granularity, bucketStart, granularity, bucketStart, granularity,
    bucketStart, granularity, bucketStart, granularity, bucketStart, granularity
  );
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
  return { sessions: Number(sessions.changes), observations: interruptOpenObservations(db, agentId, now) };
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

export interface TraceFilter {
  agent_id?: string;
  project?: string;
  status?: string;
  session_id?: string;
  since?: number;
  until?: number;
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
}

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
  };
}

/**
 * A trace's status is its root observation's; a root still open (`end` NULL,
 * no verdict yet - the reporter's eager start) is 'running'.
 */
const ROOT_STATUS =
  `(SELECT CASE WHEN r.status IS NULL AND r."end" IS NULL THEN 'running' ELSE r.status END ` +
  `FROM observations r WHERE r.trace_id = o.trace_id AND r.parent_obs_id IS NULL LIMIT 1)`;

/** The trace list's WHERE/HAVING pieces, shared by the page query and its total. */
function traceFilterWhere(filter: TraceFilter): { where: string; having: string; params: (string | number | null)[] } {
  const params: (string | number | null)[] = [];
  let where = '1 = 1';
  const arg = (value: string | number | null): string => {
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
    `CASE WHEN SUM(o.status = 'error') > 0 THEN 'error' ELSE 'ok' END) = ${status2})`;
  return { where, having, params };
}

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
    (SELECT r.name FROM observations r WHERE r.trace_id = o.trace_id AND r.parent_obs_id IS NULL LIMIT 1) AS name,
    ${ROOT_STATUS} AS root_status
  FROM observations o
`;

export function listTraces(db: SqlDatabase, filter: TraceFilter): { traces: TraceRow[]; total: number } {
  const { where, having, params } = traceFilterWhere(filter);
  const grouped = `FROM observations o WHERE ${where} GROUP BY o.trace_id HAVING ${having}`;
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM (SELECT o.trace_id ${grouped})`).get(...params)?.n ?? 0);
  const rows = db
    .prepare(`${TRACE_SELECT.replace('FROM observations o', `FROM observations o WHERE ${where}`)} GROUP BY o.trace_id HAVING ${having} ORDER BY start DESC LIMIT ? OFFSET ?`)
    .all(...params, filter.limit, filter.offset);
  return { traces: rows.map(traceRow), total };
}

export interface ObservationRow {
  obs_id: string;
  trace_id: string;
  session_id: string | null;
  agent_id: string | null;
  parent_obs_id: string | null;
  kind: string;
  name: string | null;
  start: number;
  end: number | null;
  status: string | null;
  input: string | null;
  output: string | null;
  model: string | null;
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  usage_cached_tokens: number | null;
  usage_reasoning_tokens: number | null;
  cost_usd: number | null;
  cost_partial: boolean | null;
  usage_estimated: boolean | null;
  truncated: boolean;
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
    let hostname: string | null = null;
    let pid: number | null = null;
    if (typeof row.meta === 'string') {
      try {
        const meta = JSON.parse(row.meta) as { hostname?: unknown; pid?: unknown };
        hostname = typeof meta.hostname === 'string' ? meta.hostname : null;
        pid = typeof meta.pid === 'number' ? meta.pid : null;
      } catch {
        // malformed meta: freshness still derives from defaults
      }
    }
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
  // Aggregate the day-granularity buckets inside the window; runs_per_day is
  // averaged over the window's days, not only days that saw traffic.
  const windowDays = Math.max(1, Math.ceil((windowMs.until - windowMs.since) / DAY_MS));
  const sinceDay = windowMs.since - (windowMs.since % DAY_MS);
  const metrics = new Map<string, Map<string, number>>();
  for (const row of db
    .prepare(
      `SELECT agent_id, metric, SUM(value) AS v FROM rollups
       WHERE granularity = 'day' AND bucket_start >= ? AND bucket_start < ?
       GROUP BY agent_id, metric`
    )
    .all(sinceDay, windowMs.until)) {
    const agentId = String(row.agent_id);
    const m = metrics.get(agentId) ?? new Map<string, number>();
    m.set(String(row.metric), Number(row.v));
    metrics.set(agentId, m);
  }
  const durations = new Map<string, number[]>();
  for (const row of db
    .prepare(
      // A run still open (or interrupted) has no latency yet; a zero would drag the percentiles down.
      `SELECT agent_id, "end" - start AS d FROM observations
       WHERE parent_obs_id IS NULL AND agent_id IS NOT NULL AND "end" IS NOT NULL AND start >= ? AND start < ?
       ORDER BY agent_id, d`
    )
    .all(windowMs.since, windowMs.until)) {
    const list = durations.get(String(row.agent_id)) ?? [];
    list.push(Number(row.d));
    durations.set(String(row.agent_id), list);
  }
  const names = new Map<string, { project: string | null; name: string | null }>();
  for (const agent of listAgents(db)) names.set(agent.agent_id, { project: agent.project, name: agent.name });
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
      runs_per_day: runs / windowDays,
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
