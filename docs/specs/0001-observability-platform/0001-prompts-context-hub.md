# 0001-prompts-context-hub: registry and shared memory

## Summary

Two related stores in one child. The prompt registry versions agent instructions in the daemon; agents fetch `name@version` at run start and every run logs which version it used. The Context Hub is a shared memory store agents can publish to and query, scoped `private` (one agent) or `fleet` (all agents on the daemon).

## Decision

Prompts live in the `prompts` table, edited in Studio or pushed via `lousho prompt push`. An agent opts in with `createAgent({ prompt: 'mira@latest' })` or env `LOUSHO_PROMPT`; the SDK fetches text at agent build, falls back to embedded instructions when the daemon is unreachable. `prompt_uses` rows link every run to the exact prompt version that produced it, closing the loop with evals.

Context Hub entries are namespaced key values in `hub_entries`; agents get `hub.publish` / `hub.query` tools (or memory API calls) when `LOUSHO_OBSERVE` is set. `scope: private` entries are visible only to the writing `agent_id`; `scope: fleet` to all.

## Surface

**Registry API** (on the daemon): `GET /api/v1/prompts/:name/:version` for agents, `POST /api/v1/prompts` for publish, list and diff endpoints for Studio. `@latest` is a movable label resolved daemon side, never in the SDK, so "latest" means the same thing for every agent at once. Each fetch that lands in a run emits a `prompt_use` ingest event (in the shared envelope), which is what writes `prompt_uses` rows.

**Hub API**: `POST /api/v1/hub` (publish) and `GET /api/v1/hub?namespace&scope` (query). Scope enforcement happens daemon side using the caller's `agent_id`; the SDK just asks.

**Studio**: prompt editor with version history and a "used by N runs" link into traces; hub browser with namespace filtering.

## Deferred to its FEATURE spec

- Prompt variable templating (mustache vs plain interpolation) and validation on publish.
- Fleet scope write policy: who may publish fleet entries (any agent vs an allowlist).
- Hub TTL and size limits per entry.
- Whether hub entries should feed `memory_search` retrieval automatically.

## Rationale

Prompt versioning is the single highest leverage observability feature after traces: "what did this run see" is unanswerable today. Fetch at build keeps agents runnable when the daemon is down (embedded instructions are the fallback), which matters more than push convenience. Shared memory between agents is how Mira's learned facts reach Ghost without copy pasting; scope keeps it a deliberate share, not an automatic leak.
