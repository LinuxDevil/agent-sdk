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
 *   last-writer-wins.
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
import { OBSERVE_TRUNCATE_CHARS, type IngestEvent, type ObservationData } from './envelope';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Granularity labels as stored in `rollups.granularity`. */
export const ROLLUP_GRANULARITIES = { hour: HOUR_MS, day: DAY_MS } as const;
export type RollupGranularity = keyof typeof ROLLUP_GRANULARITIES;

/** The metrics `rollups` keeps per (bucket, agent); all over root observations (a run's `invoke_agent` span). */
export const ROLLUP_METRICS = ['runs', 'errors', 'cost_usd', 'input_tokens', 'output_tokens', 'latency_ms'] as const;

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
    cost_usd, cost_partial, usage_estimated, truncated, attrs, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(obs_id) DO UPDATE SET
    trace_id = excluded.trace_id,
    session_id = excluded.session_id,
    agent_id = excluded.agent_id,
    parent_obs_id = excluded.parent_obs_id,
    kind = excluded.kind,
    name = excluded.name,
    start = excluded.start,
    "end" = excluded."end",
    status = excluded.status,
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
    updated_at = excluded.updated_at
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
      return;
    }
    case 'agent.deregister': {
      const d = event.data;
      const ts = d.ts ?? now;
      db.prepare(DEREGISTER_UPSERT).run(d.agent_id, ts, ts, now);
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
              COALESCE("end", start) - start AS duration
       FROM observations
       WHERE parent_obs_id IS NULL AND agent_id IS NOT NULL AND start >= ? AND start < ?
     )
     INSERT INTO rollups (bucket_start, granularity, agent_id, metric, value)
     SELECT ?, ?, agent_id, 'runs', COUNT(*) FROM roots GROUP BY agent_id
     UNION ALL SELECT ?, ?, agent_id, 'errors', SUM(status = 'error') FROM roots GROUP BY agent_id
     UNION ALL SELECT ?, ?, agent_id, 'cost_usd', SUM(COALESCE(cost_usd, 0)) FROM roots GROUP BY agent_id
     UNION ALL SELECT ?, ?, agent_id, 'input_tokens', SUM(COALESCE(usage_input_tokens, 0)) FROM roots GROUP BY agent_id
     UNION ALL SELECT ?, ?, agent_id, 'output_tokens', SUM(COALESCE(usage_output_tokens, 0)) FROM roots GROUP BY agent_id
     UNION ALL SELECT ?, ?, agent_id, 'latency_ms', SUM(duration) FROM roots GROUP BY agent_id`
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

export function hashTokenKey(key: string): string {
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
    `(SELECT r.status FROM observations r WHERE r.trace_id = o.trace_id AND r.parent_obs_id IS NULL LIMIT 1), ` +
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
    (SELECT r.status FROM observations r WHERE r.trace_id = o.trace_id AND r.parent_obs_id IS NULL LIMIT 1) AS root_status
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

export function listScores(
  db: SqlDatabase,
  filter: { trace_id?: string; name?: string; agent_id?: string; limit: number }
): { scores: ScoreRow[] } {
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
  if (filter.agent_id !== undefined) {
    where += ' AND agent_id = ?';
    params.push(filter.agent_id);
  }
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
 * Fleet registry rows plus read-time freshness. The monitoring child owns the
 * periodic sweep that rewrites `agents.status`; until then the read path
 * derives it: stored 'stopped' wins (a graceful exit), else the row ages
 * `healthy` -> `stale` -> `down` against its heartbeat interval (default 60s:
 * stale past 2 intervals, down past 10).
 */
export function listAgents(db: SqlDatabase, now: number = Date.now()): AgentRow[] {
  const rows = db.prepare('SELECT * FROM agents ORDER BY COALESCE(last_heartbeat, first_seen) DESC').all();
  return rows.map((row) => {
    let interval: number | null = null;
    let hostname: string | null = null;
    let pid: number | null = null;
    if (typeof row.meta === 'string') {
      try {
        const meta = JSON.parse(row.meta) as { heartbeat_interval_ms?: unknown; hostname?: unknown; pid?: unknown };
        interval = typeof meta.heartbeat_interval_ms === 'number' ? meta.heartbeat_interval_ms : null;
        hostname = typeof meta.hostname === 'string' ? meta.hostname : null;
        pid = typeof meta.pid === 'number' ? meta.pid : null;
      } catch {
        // malformed meta: freshness still derives from defaults
      }
    }
    const lastHeartbeat = row.last_heartbeat === null ? null : Number(row.last_heartbeat);
    const age = lastHeartbeat === null ? null : Math.max(0, now - lastHeartbeat);
    const step = interval ?? 60_000;
    const stored = String(row.status ?? 'healthy');
    const status =
      stored === 'stopped' ? 'stopped' : age === null ? stored : age < 2 * step ? 'healthy' : age < 10 * step ? 'stale' : 'down';
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
      `SELECT agent_id, COALESCE("end", start) - start AS d FROM observations
       WHERE parent_obs_id IS NULL AND agent_id IS NOT NULL AND start >= ? AND start < ?
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
