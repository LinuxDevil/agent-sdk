# companion — persistent AI-companion harness

A Replika-style audit of `@lousho/build-ai-agent@1.0.0-alpha.18` (packed
tarball, live against OpenRouter `openai/gpt-4o-mini`): **Nova**, an AI
companion that remembers the user across "days", holds a consistent persona,
and keeps an evolving relationship state.

## What it exercises

| Surface | How |
|---|---|
| Persona | `instructions` character card; checked for assistant-drift phrasing across 6 turns |
| Long-term memory | Two `defineMemory` slots (`user_facts`, `relationship`) scoped by verified `principal`, backed by `sqliteMemory(store)`; `remember_*`/`recall_*` tools + `<memory>` system-prompt injection verified via a `preGenerate` hook |
| Session resume | `SqliteStore` → `store.sessions` transcript; run 2 builds a NEW store+agent+session objects over the same db file and session id after `store.close()` — a process-restart equivalent |
| Dynamics state | `update_relationship` tool (zod-typed) writing `data/relationship.json`; plus a free-text `relationship` memory slot for vibe notes |
| Streaming | `session.stream()` — `text.delta` count and reassembly checked against `text.done` |
| Compaction | `compaction: { contextWindow: 128k, threshold: 85% }` configured; events watched (not expected to fire on 6 short turns) |

## Run

```bash
cd audit
npx tsx companion/index.ts           # live; needs OPENROUTER_API_KEY in ../.env
npx tsx companion/index.ts --fresh   # wipe companion/data first
npx tsx companion/repro/slot-collision.ts   # offline repro (mockModel, :memory: sqlite)
```

State lives in `companion/data/` (`companion.db`, `relationship.json`).

## Findings

See `FINDINGS.md`. Headline: two memory slots that resolve to the same scope
key silently share one item bucket (the slot name is not part of the storage
key) — verified live and in `repro/slot-collision.ts`.
