/**
 * The collector database's schema. Like the session store (src/storage/sqlite),
 * migrations are forward-only strings applied by the shared `migrate()` runner
 * against `PRAGMA user_version` - append new entries, never edit shipped ones.
 *
 * The tables are the cross-child contract of
 * docs/specs/0001-observability-platform/index.md: `observations` is the wide
 * denormalized table every run event lands in (traces are virtual - the set of
 * rows sharing one `trace_id`), `agents`/`sessions` are the registry,
 * `scores`/`prompts`/`prompt_uses`/`hub_entries` belong to later children but
 * are created here so the data plane's db is the only file the platform needs,
 * `rollups` is a disposable derivation (never a second write path), and
 * `tokens` holds hashed daemon keys.
 *
 * No FOREIGN KEY constraints: ingest is batched and order is not guaranteed
 * (a `prompt_use` can land before its observation; scores can name traces
 * emitted by another agent). Integrity comes from primary-key upserts, not
 * from rejecting rows.
 */

import type { SqlDatabase } from '../storage/sqlite/driver';
import { migrate } from '../storage/sqlite/migrations';

/**
 * Forward-only migrations for the observe database. `OBSERVE_MIGRATIONS[n]`
 * upgrades a database from `user_version` n to n + 1.
 */
export const OBSERVE_MIGRATIONS: readonly string[] = [
  `
  -- Fleet registry: one row per reporting agent. status is the last known
  -- state ('healthy' on heartbeat, 'stopped' on deregister); monitoring
  -- derives freshness from last_heartbeat at read/sweep time.
  CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY,
    project TEXT,
    name TEXT,
    version TEXT,
    first_seen INTEGER NOT NULL,
    last_heartbeat INTEGER,
    status TEXT NOT NULL DEFAULT 'healthy',
    meta TEXT,
    updated_at INTEGER NOT NULL
  );

  -- Conversation threads. Rows are derived lazily from observations that
  -- carry a session_id (there is no session event type in the envelope).
  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    agent_id TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_agent ON sessions (agent_id);

  -- The wide table (Langfuse v4 shape): every finished span, generation,
  -- tool call and point-in-time event, with trace-level fields flattened
  -- onto the row. obs_id is the reporter's TraceLine.id; resends upsert
  -- by key and updated_at gives last writer wins.
  CREATE TABLE observations (
    obs_id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    session_id TEXT,
    agent_id TEXT,
    parent_obs_id TEXT,
    kind TEXT NOT NULL,
    name TEXT,
    start INTEGER NOT NULL,
    end INTEGER,
    status TEXT,
    input TEXT,
    output TEXT,
    model TEXT,
    usage_input_tokens REAL,
    usage_output_tokens REAL,
    usage_cached_tokens REAL,
    usage_reasoning_tokens REAL,
    cost_usd REAL,
    cost_partial INTEGER,
    usage_estimated INTEGER,
    truncated INTEGER NOT NULL DEFAULT 0,
    attrs TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX observations_trace ON observations (trace_id);
  CREATE INDEX observations_session ON observations (session_id);
  CREATE INDEX observations_agent ON observations (agent_id);
  CREATE INDEX observations_start ON observations (start);
  CREATE INDEX observations_parent ON observations (parent_obs_id);

  -- Eval results beside runs (evaluators child emits them; the data plane stores).
  CREATE TABLE scores (
    score_id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    obs_id TEXT,
    name TEXT NOT NULL,
    value REAL,
    source TEXT NOT NULL,
    comment TEXT,
    agent_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX scores_trace ON scores (trace_id);
  CREATE INDEX scores_name ON scores (name);

  -- The prompt registry (prompts-context-hub child): one row per published version.
  CREATE TABLE prompts (
    prompt_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    labels TEXT,
    text TEXT,
    variables TEXT,
    hash TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX prompts_name_version ON prompts (name, version);

  -- Which prompt version a run's observation ran with.
  CREATE TABLE prompt_uses (
    obs_id TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    version INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (obs_id, prompt_id)
  );
  CREATE INDEX prompt_uses_prompt ON prompt_uses (prompt_id);

  -- Shared memory between agents (prompts-context-hub child). scope is
  -- organizational, not a security boundary (the threat model trusts loopback).
  CREATE TABLE hub_entries (
    entry_id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    agent_id TEXT,
    "key" TEXT NOT NULL,
    value TEXT,
    scope TEXT NOT NULL DEFAULT 'private',
    created_at INTEGER NOT NULL,
    ttl INTEGER
  );
  CREATE INDEX hub_entries_namespace ON hub_entries (namespace, scope, "key");

  -- Insights aggregates, a disposable derivation of observations:
  -- recomputed with INSERT ... SELECT ... GROUP BY inside the ingest
  -- transaction (so a resent batch can never double count), and wholesale
  -- by 'lousho observe rebuild-rollups'. Metrics per (bucket, agent):
  -- 'runs', 'errors', 'cost_usd', 'input_tokens', 'output_tokens',
  -- 'latency_ms' (sum of root-observation durations).
  CREATE TABLE rollups (
    bucket_start INTEGER NOT NULL,
    granularity TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (bucket_start, granularity, agent_id, metric)
  );
  CREATE INDEX rollups_agent ON rollups (agent_id, granularity, bucket_start);

  -- Daemon auth keys, hashed (sha256). Only checked when the daemon is
  -- bound non-loopback or --require-token is set; loopback trusts the machine.
  CREATE TABLE tokens (
    token_id TEXT PRIMARY KEY,
    project TEXT,
    key_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  `,
  `
  -- One row per live reporter process ("instance") of an agent: agent_id is
  -- persisted per (name, project, cwd), so a restart or a sibling process
  -- reports under the same agent_id. A run's root observation carries the
  -- instance that started it, so a killed instance's open runs can be
  -- interrupted while another instance of the agent keeps heartbeating.
  -- hostname/pid/heartbeat_interval_ms come from the heartbeat (NULL from
  -- older SDKs). first_seen/last_heartbeat are the DAEMON's receive times, so
  -- a reporter's skewed clock cannot make a live instance look silent.
  CREATE TABLE agent_instances (
    agent_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    hostname TEXT,
    pid INTEGER,
    heartbeat_interval_ms INTEGER,
    first_seen INTEGER NOT NULL,
    last_heartbeat INTEGER NOT NULL,
    PRIMARY KEY (agent_id, instance_id)
  );
  ALTER TABLE observations ADD COLUMN instance_id TEXT;
  `,
  `
  -- Prompt labels: a movable name per prompt ('prod', 'staging') that points
  -- at exactly one version - the PRIMARY KEY is that guarantee, so moving a
  -- label is one upsert. Backfilled from array-form prompts.labels (string
  -- entries that are not themselves refs - 'latest' or all digits; the
  -- highest version carrying a label wins). Record-form labels stay in the
  -- column untouched.
  CREATE TABLE prompt_labels (
    name TEXT NOT NULL,
    label TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (name, label)
  );
  INSERT INTO prompt_labels (name, label, version, updated_at)
    SELECT p.name, j.value, MAX(p.version), MAX(p.created_at)
    FROM prompts p,
      json_each(CASE WHEN json_valid(p.labels) AND json_type(p.labels) = 'array' THEN p.labels ELSE '[]' END) j
    WHERE j.type = 'text' AND j.value <> '' AND j.value <> 'latest' AND j.value GLOB '*[^0-9]*'
      AND j.value NOT GLOB '*[@/ ]*'
    GROUP BY p.name, j.value;
  `,
  `
  -- Datasets: named sets of eval examples. input/expected are JSON text;
  -- source_trace_id records the trace an example was copied from and is
  -- deliberately not a foreign key - retention may prune that trace, the
  -- example stays. Retention never touches these tables.
  CREATE TABLE datasets (
    dataset_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE dataset_examples (
    example_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL REFERENCES datasets(dataset_id) ON DELETE CASCADE,
    input TEXT NOT NULL,
    expected TEXT,
    source_trace_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX dataset_examples_by_dataset ON dataset_examples (dataset_id, created_at);
  `,
  `
  -- Online evaluator rules: which traces to score (filter JSON, sample_rate
  -- in [0, 1]) and how (kind 'code' with config { source }, or 'judge' with
  -- config { model, rubric }). Stored only; the runner reads them in
  -- created_at order.
  CREATE TABLE evaluator_rules (
    rule_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    filter TEXT NOT NULL DEFAULT '{}',
    sample_rate REAL NOT NULL DEFAULT 1,
    kind TEXT NOT NULL CHECK(kind IN ('code','judge')),
    config TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  -- Annotation queues: named lists of traces for a human to review, with an
  -- optional rubric (JSON array of { name, description?, min?, max? }).
  -- annotation_items.trace_id is deliberately not a foreign key - retention
  -- may prune the trace, the item stays. Retention never touches these
  -- tables. foreign_keys is off, so deleting a queue deletes its items
  -- explicitly; the CASCADE only documents the intent.
  CREATE TABLE annotation_queues (
    queue_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    rubric TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE annotation_items (
    item_id TEXT PRIMARY KEY,
    queue_id TEXT NOT NULL REFERENCES annotation_queues(queue_id) ON DELETE CASCADE,
    trace_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','skipped')),
    reviewer TEXT,
    created_at INTEGER NOT NULL,
    done_at INTEGER,
    UNIQUE (queue_id, trace_id)
  );
  CREATE INDEX annotation_items_by_status ON annotation_items (queue_id, status, created_at);
  `,
];

/**
 * Bring `db` to the newest observe schema version. Thin wrapper over the
 * shared runner so this module is the only place that knows which migration
 * set the collector database uses.
 */
export function migrateObserve(db: SqlDatabase): number {
  return migrate(db, OBSERVE_MIGRATIONS);
}
