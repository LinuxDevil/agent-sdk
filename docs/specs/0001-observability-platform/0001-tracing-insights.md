# 0001-tracing-insights: the data plane

## Summary

The core of the platform: every agent run becomes observation rows in the collector's SQLite store, queryable as traces in Studio. Insights is aggregate analytics over those rows: latency, cost, error rate, token usage, per agent and per project.

## Decision

Build the data plane first; it is the dependency for every other child. The SDK gains an in process reporter that drains run events into batched `POST /api/v1/ingest` calls when `LOUSHO_OBSERVE` is set. The daemon writes them into the `observations` wide table and maintains `rollups` for Insights queries.

## Surface

**Reporter** (`src/observe/reporter.ts`): subscribes to the existing run events (the same stream `src/traces` produces), buffers them, flushes on size (default 50 events) or interval (default 5s), flushes on process exit with a ~2s cap. Crash loss is accepted and bounded: nothing persists mid run, and unflushed events count into the same `dropped` metric as daemon unreachable. Failure mode stays drop and count, never block a run. The reporter's own HTTP calls to the daemon are excluded from instrumentation or it recurses.

**Daemon write path**: ingest validates the envelope, upserts by `obs_id` (resends are idempotent), updates the agent registry `last_heartbeat`, and recomputes affected `rollups` bucket rows inside the same transaction (`INSERT … SELECT … GROUP BY`, so a resent batch can never double count; see the index contract).

**Studio panels** (new in `apps/agent-forge`):
- Traces list: session and trace rows per project, filterable by status, agent, time.
- Trace detail: the observation tree (spans, generations, tool calls) with inputs, outputs, token usage, and latency waterfall.
- Insights: per agent cards (runs/day, p50/p95 latency, cost, error rate) plus time series from `rollups`.

**Insights queries** read `rollups` for aggregates and `observations` for drilldown; no query hits raw rows for dashboard level numbers.

## Deferred to its FEATURE spec

- Exact rollup granularities and retention (minute rows for 24h, hour rows for 30d is the likely shape).
- Trace list pagination and filtering contract.
- The `/api/v1/query` read endpoints' exact shape (decided at index: HTTP only, daemon owns the db).

## Rationale

Traces are the substrate every other surface reads; building them first is the only ordering that avoids rework. The reporter reuses the existing event stream instead of a new instrumentation layer (basis: `src/traces` already emits run and step events). Denormalized rows keep every common query (per trace, per session, per agent, per model) a single table scan (basis: Langfuse v4 observations first model, in `rationale.md`).
