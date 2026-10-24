# Rationale: observability platform

## Context

> ⚠️ Premise note: the request listed ten subsystems (Engine, Studio, Build, Tracing, Insights, Monitoring, Evaluators, Prompts, Context Hub, Sandboxing), which is a product, not one decision. Five of the ten already exist in the SDK (the runtime, Agent Forge Studio, `lousho build`, `src/traces`, `src/evals`). This spec fixes the platform foundation the genuinely new pieces share; each subsystem still needs its own feature spec before build.

The SDK runs agents inside the user's own Node process. Once agents ship, there is no place to see what they did: which tools ran, what a run cost, where it failed, whether behavior drifted between versions. LangSmith answers this for LangChain by being a hosted service every agent reports to; the SDK's equivalent must work without anyone running infrastructure, because most users will not.

The engineer runs a fleet of bots on one machine (a companion, a security agent, a business agent, a trading agent). Their real need, a single pane over all of them, already forces a collector that outlives any one project directory. That makes the honest architecture a small local service, not a per project log file.

## Options considered

### Option 1: hosted service first

A new `apps/observatory` server: agents POST runs over API keys, Postgres storage, a web dashboard. The true LangSmith shape.

**Pros**:
- Works across machines and teams from day one.
- No questions about where data lives; one service owns it.

**Cons**:
- Ships auth, tenancy, and ops on day one for a feature most users want locally.
- A second product to maintain before the first one has proven its data model.
- Every SDK user needs an account or self hosting just to see a run.

### Option 2: hybrid platform, local first (chosen)

An open ingest API plus a local implementation now: `lousho observe` daemon, SQLite, Studio panels. A hosted collector implements the same API later.

**Pros**:
- Fleet view today (one daemon per machine), hosted view later by repointing `LOUSHO_OBSERVE`.
- The data model and ingest contract get proven locally before they harden into a service API.
- Zero infrastructure for SDK users; matches how sessions already store locally.

**Cons**:
- The local daemon is one more process; monitoring dies quietly when it is not running.
- The API contract must be designed for the hosted future now (batching, idempotency, project scoping) or the upgrade path rots.

### Option 3: OTel native, no own surface

Emit OpenTelemetry only; point users at Jaeger or Grafana.

**Pros**:
- Nothing new to build or operate on our side.

**Cons**:
- Generic spans, not agent aware: no sessions, evals, prompt versions, or fleet registry. That is tracing tooling, not a LangSmith clone.
- OTel GenAI semantic conventions are still "Development" status; depending on them alone bakes in churn.

### Option 4: per project store only

Each project writes `.lousho/traces.db`, viewed only inside that project's Studio.

**Pros**:
- No daemon, no network, simplest possible.

**Cons**:
- Permanently rules out a fleet pane and observing deployed agents; Monitoring as scoped cannot exist.

## Rationale

Local scale is small (tens of agents, millions of rows at most), so the storage and analytics problems Langfuse solved with ClickHouse simply do not exist here (basis: landscape check). better-sqlite3 is already the session store dependency, so SQLite with rollup tables is the boring correct pick; DuckDB Neo is now a real embedded OLAP option but a ~30MB binary on a 2.0.0 release is not a v1 dependency for this size.

The schema decision borrows directly from Langfuse's own migration path: they ended at an observations first denormalized model because trace level queries dominate everything (basis: Langfuse v4 observations first model). One wide table with flattened trace attributes is also exactly what SQLite is good at, and `gen_ai.*` attribute names keep a future OTLP exporter cheap even though the convention is still moving.

For sandboxing, the durable decision is the driver interface, not the isolate engine. `isolated-vm` works today but is maintenance mode and a native module; the agents world has already converged on pluggable sandbox drivers (isolate for speed, containers or E2B for real isolation). Shipping the seam plus the fast driver mirrors that consensus (basis: TanStack AI isolate driver pattern).

The loopback only, no auth default follows the repo's own node server rule: refuse to bind publicly without a token rather than protect inside. A token option exists for the hosted path without changing the local default.

## References

**Project sources** (verifiable, in this repo):
- `apps/agent-forge`: the existing Studio app the dashboard panels extend.
- `src/traces`, `src/execution`: the run and step event source the reporter consumes.
- `src/evals`: `defineEval`, `llmJudge`, cassettes already produce eval outputs that become score rows.
- `FileSessionStore` and the node server auth rule (`src/server`): the SQLite precedent and the loopback binding convention this spec copies.
- `LOUSHO_API_TOKEN` / `LOUSHO_ALLOW_PUBLIC` pattern: the existing env contract style `LOUSHO_OBSERVE*` follows.

**Practices & standards**:
- Langfuse data model and ingestion API shape (observations first, batched ingest).
- OpenTelemetry GenAI semantic conventions for attribute names (`gen_ai.*`), used as names only while the convention stays in Development status.
- TanStack AI isolate driver pattern for the sandbox seam.

**Links** (web verified during the landscape check):
- Langfuse architecture: https://langfuse.com/handbook/product-engineering/architecture
- Langfuse observability data model: https://langfuse.com/docs/observability/data-model
- Langfuse v3 to v4 upgrade (observations first move): https://langfuse.com/self-hosting/upgrade/upgrade-v3-to-v4
- ClickHouse at agent scale (Langfuse engineering): https://langfuse.com/resources/engineering/clickhouse-at-agent-scale
- isolated-vm repository (status, compat table): https://github.com/laverdet/isolated-vm
- TanStack AI code mode isolates docs: https://tanstack.com/ai (code mode isolates)
- DuckDB Node Neo client: https://github.com/duckdb/duckdb-node-neo and https://duckdb.org/2024/12/18/duckdb-node-neo-client
- OTel GenAI semantic conventions repo: https://github.com/open-telemetry/semantic-conventions-genai

## Landscape evidence (what the check actually found)

- DuckDB Neo (`@duckdb/node-api`) is the official, TypeScript native client with prebuilt binaries and ~1.18M weekly downloads; the v2.0.0 line just shipped with the maintainer warning that bugs are likely on the major bump. Pick worthy later, not now.
- `isolated-vm` v7.0.1 tracks current Node majors but is explicitly maintenance mode and carries known isolation limits. `node:vm` is documented as not a security boundary. Agents and eval frameworks mostly use container or microVM sidecars for real untrusted code.
- Langfuse runs Postgres plus ClickHouse plus a worker queue at SaaS scale; their v4 flattened traces into virtual root spans over one wide observations table. That denormalized shape, not their infra, is what transfers to a local store.
- OTel GenAI semconv moved to its own repo and remains Development status; Arize OpenInference is the alternative convention. Adopt names, not the pipeline.
