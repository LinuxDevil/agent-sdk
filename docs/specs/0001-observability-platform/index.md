# 0001. Observability platform for the SDK

**Date**: 2026-10-22
**Status**: Proposed

## Summary

Build an observability platform inside the SDK so every agent run, step, tool call, and eval score lands in one searchable place. A small local daemon collects data from every agent on the machine into one SQLite file; agents opt in with an env var and need no code changes. The shape is a local version of LangSmith on purpose, so a hosted collector can implement the same ingest API later with no SDK changes.

## Structure

Umbrella spec. Each child is one subsystem decision under this platform:

- [0001-tracing-insights.md](0001-tracing-insights.md): the data plane. Observation rows, the ingest API, Insights rollups, Studio trace panels. The value core, built first.
- [0001-monitoring.md](0001-monitoring.md): the fleet registry. Agent heartbeats, live status, error rates, alert hooks.
- [0001-evaluators.md](0001-evaluators.md): eval scores as first class rows beside runs, plus Studio and CI surfaces over the existing `src/evals`.
- [0001-prompts-context-hub.md](0001-prompts-context-hub.md): the versioned prompt registry and the shared memory hub between agents.
- [0001-sandboxing.md](0001-sandboxing.md): the sandbox driver interface and the isolated-vm driver for untrusted tool code.

## Decision

**Chosen option**: Option 2: hybrid platform, local first.

A local collector daemon (`lousho observe`) owns one SQLite store for the whole machine. SDK agents emit batched observation events to it over an open HTTP ingest API when `LOUSHO_OBSERVE` is set (or `createAgent({ observability })` is passed). The dashboard is new panels inside the existing `apps/agent-forge` Studio app, not a new app. The ingest API is the contract a hosted collector implements later, which is what makes this a LangSmith clone rather than just local logging.

**Implementation skills**: none installed shaped this design.

## Proposed stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript, ESM | The whole repo's convention. |
| Collector daemon | `lousho observe` CLI + `src/observe/` module, plain `node:http` | No new framework for a loopback API; the CLI already owns daemon style commands. |
| Primary DB | SQLite via better-sqlite3, rollup tables for Insights | Already the SDK store for sessions; transactional writes plus hand rolled rollups cover local scale analytics. |
| Ingest API | `POST /api/v1/ingest`, batched envelope, loopback only, no auth | Langfuse shaped batching (basis: Langfuse ingestion API); loopback binding matches the node server rule, refuse public bind without a token. |
| Agent wiring | `LOUSHO_OBSERVE` env (`=1` local default or a URL) plus `createAgent({ observability })` | Env first means existing bots emit with zero code changes; the config object stays the explicit override. |
| Dashboard | Panels inside `apps/agent-forge` (React, Vite) | One Studio to build, run, and inspect agents; the app shell and data model already exist. |
| Trace schema | Observations first, denormalized rows, `gen_ai.*` attribute names | The Langfuse v4 pattern (one wide table, trace attrs flattened per row) fits SQLite cleanly; semconv names keep OTLP export a rename away. |
| Sandboxing | Driver interface `sandbox(driver)`; v1 ships `isolated-vm` | A driver seam keeps in process speed now and Docker or E2B sidecars open later (basis: TanStack AI isolate drivers). |
| Hosted path | Same ingest API on a remote endpoint | No SDK change needed to point agents at a hosted collector later. |

## Cross child contract

Every child spec builds on these shared shapes. They are the contract between the emitter, the daemon, and Studio.

**Entities** (single SQLite file, default `~/.lousho/observe.db`):

| Entity | Rows | Key fields |
|---|---|---|
| `agents` | one per reporting agent | `agent_id` (pk), `project`, `name`, `version`, `first_seen`, `last_heartbeat`, `status` |
| `sessions` | conversation threads | `session_id` (pk), `agent_id` (fk), `started_at`, `ended_at`, `status` |
| `observations` | the wide table | `obs_id` (pk), `trace_id`, `session_id`, `agent_id`, `parent_obs_id`, `kind` (`span`, `generation`, `tool`, `event`), `name`, `start`, `end`, `status`, `input`, `output`, `model`, `usage_*`, `cost_*`, `attrs` (JSON, `gen_ai.*` names) |
| `scores` | eval results | `score_id` (pk), `trace_id`, `obs_id` nullable, `name`, `value` numeric, `source` (`eval`, `judge`, `human`), `comment` |
| `prompts` | registry entries | `prompt_id` (pk), `name`, `version`, `labels`, `text`, `variables`, `created_at`, `hash` |
| `prompt_uses` | run linkage | `obs_id` (fk), `prompt_id` (fk), `version` |
| `hub_entries` | shared memory | `entry_id` (pk), `namespace`, `agent_id` (writer), `key`, `value`, `scope` (`private`, `fleet`), `created_at`, `ttl` |
| `rollups` | Insights aggregates | `bucket_start`, `granularity`, `agent_id`, `metric`, `value` |
| `tokens` | daemon auth keys | `token_id` (pk), `project`, `key_hash`, `created_at`, `revoked_at` |

Traces are virtual: a trace is the set of `observations` sharing one `trace_id`, with the root span carrying trace level fields flattened onto every row (the Langfuse v4 move (basis: Langfuse v4 observations first model)).

**Field and id provenance** (decided, not builder invention):

- `obs_id` is the existing `TraceLine.id` from `src/traces` (never a fresh UUID per flush), so resent batches upsert by key. `updated_at` gives last writer wins on re-emitted rows.
- `session_id` is the agent session's resumable id; reporters outside sessions mint `sha256(agent_id + cwd)` persisted under `.lousho/` so a restarted process rejoins its session stream.
- `agent_id` is a reporter generated UUID persisted at `~/.lousho/identity/<name>@<project>`.
- `usage_*`/`cost_*` carry `StepUsage` from `src/models/usage.ts` verbatim (`usage_input/output/cached/reasoning_tokens`, `cost_usd`, `cost_partial`, `usage_estimated`); the daemon stores them, it never recomputes; the `cost_partial` and `estimated` flags must survive to Studio or cost numbers lie.
- One event per **finished** observation carrying `start` + `end`; in-flight spans are reporter local state (matches `TraceLine` semantics).
- `rollups` is a disposable derivation, not a second write path: recompute bucket rows with `INSERT … SELECT … GROUP BY` inside each ingest transaction (idempotent on resends), plus `lousho observe rebuild-rollups` for repair.
- `observations` is source of truth; WAL mode plus `busy_timeout=5000` at open, single writer daemon.

**Threat model**: any process on loopback is trusted. `hub` `private` scope is organizational (keeps agents' views clean), not a security boundary. Public binding still requires a token per the node server rule.

**Ingest API** (the only endpoint that matters; query endpoints are child scope):

```http
POST /api/v1/ingest
{ "batch": [
    { "type": "agent.heartbeat",  "data": { "agent_id": "...", "project": "...", ... } },
    { "type": "agent.deregister", "data": { "agent_id": "..." } },
    { "type": "observation",      "data": { "obs_id": "...", "trace_id": "...", ... } },
    { "type": "prompt_use",       "data": { "obs_id": "...", "prompt_id": "...", "version": 3 } },
    { "type": "score",            "data": { "score_id": "...", "trace_id": "...", ... } }
] }
```

Batched, async, idempotent by row primary key (a resent batch upserts). The daemon acks fast and writes off the request path. Payload limits: `input`/`output` strings truncate at about 64KB with a `truncated` flag set; a batch over about 5MB gets `413` and counts into the reporter's `dropped` metric.

**Read path** (decided, not deferred): Studio is a browser app, it cannot open `~/.lousho/observe.db`. The daemon owns the only database handle and serves every Studio read over `GET /api/v1/traces`, `/traces/:id`, `/insights`, `/agents`, `/scores`, `/prompts`, `/hub`. A "open the db file directly" path is rejected: it breaks the hosted upgrade and the single writer rule.

**Env contract**:

- `LOUSHO_OBSERVE`: `1` (or `true`) emits to `http://127.0.0.1:7777`; a URL emits there. Unset emits nothing.
- `LOUSHO_OBSERVE_PROJECT`: project label on every row (default: package name).
- `LOUSHO_OBSERVE_TOKEN`: bearer token, required only when the daemon is configured to demand one.
- `LOUSHO_OBSERVE_PORT` (or `lousho observe --port`): daemon port, default 7777. On `EADDRINUSE` the daemon probes `GET /health` for the `lousho-observe` service marker and attaches or fails with an actionable message.

**Daemon commands**: `lousho observe start|status|stop`, `lousho observe token create --project X` (writes a hashed key into `tokens`; ingest and read endpoints check it once the daemon runs non loopback), `lousho observe rebuild-rollups`.

## Consequences

**Positive**:
- One pane for the whole fleet: Monitoring actually shows every bot on the machine.
- LangSmith shape without hosting: the ingest API is the product seam, so the hosted upgrade is an endpoint swap, not a rewrite.
- Cheap adoption: env var on, everything emits; no per agent code edits.

**Negative / tradeoffs**:
- A new process to run: the fleet pane needs the daemon up; agents degrade to silent no emit when it is down (by design, but a support question).
- Hand rolled rollups: Insights aggregates live in SQL we own, no OLAP engine to lean on if query needs grow.
- `isolated-vm` is a native dependency: install friction for sandbox users only, kept behind the driver seam so core users never pay it.
- `apps/agent-forge` grows a second job: observability panels beside the builder canvas means the app's data layer must handle a remote data source, not only project files.

**Neutral**:
- New env vars (`LOUSHO_OBSERVE*`) join the config surface.
- Existing `src/traces` and OTel hooks stay as the low level event source; the reporter consumes them rather than replacing them.

## Follow-up

- [ ] Each child subsystem needs its own `/architect` FEATURE pass with real acceptance criteria before `/develop` builds it; this spec fixed the platform, not the per surface contract.
- [ ] `docs/specs/` is not in the docs site `PAGES` map; decide whether spec files belong under docs at all or move to a non published path.
- [ ] DuckDB stays a named upgrade path for Insights if SQLite rollups ever hurt; not in v1.
- [ ] Docker or E2B sandbox driver follows the isolate driver once the seam exists.
- [ ] Decide prompt registry credentials: prompt fetch from the daemon needs no auth on loopback, the hosted path needs keys.

## Rationale

Reasoning, options, and the landscape evidence: see [rationale.md](rationale.md).
