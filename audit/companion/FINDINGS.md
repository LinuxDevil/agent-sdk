# FINDINGS — companion harness (persistent AI companion)

Audit of `@lousho/build-ai-agent@1.0.0-alpha.18` (packed tarball), run live
against OpenRouter `openai/gpt-4o-mini`. Harness: `index.ts`; run output:
`RUN_LOG.md`; offline repro: `repro/slot-collision.ts`.

## Verdict per surface

| Surface | Result | Proof |
|---|---|---|
| Persona (`instructions`) | **PASS** | No "as an AI / how can I help" drift across 6 turns; stayed in character (see RUN_LOG replies) |
| Long-term memory (`defineMemory` + `remember_*`/`recall_*`) | **PASS** (with workaround, see F1) | 4 facts stored day 1; day 2 answered name + food cold, without re-telling |
| Memory injection | **PASS** | `preGenerate` hook saw `<memory name="user_facts">` in the day-2 first-call system prompt |
| Session resume across restart | **PASS** | `sessions` row `nova-alex-main` (4370 B) persisted; new store+agent+session loaded the same 14-message transcript |
| Dynamics state | **PASS** | `relationship.json`: `trust 10 -> 15`, `insideJokes:["Captain Crumb's ramen heist"]`, mood `playful -> connected`; survived the restart |
| Streaming | **PASS** | 22–28 `text.delta` events/turn; concatenated deltas === `text.done` text |
| Compaction | **not triggered** | 6 short turns ≈ 3.8k tokens max vs 85% of 128k — expected; config accepted without error |
| Scope isolation | **PASS** | sibling scope `user:cli:bob:facts` empty |

---

### F1: Two memory slots on the same scope key silently share one item bucket

- **Severity:** high
- **Type:** bug / DX
- **Evidence:** First live run used the natural design — `user_facts` and
  `relationship` slots both scoped `user:cli:alex`. Result: `remember_relationship`
  items appeared in `recall_user_facts` and vice versa; both
  `provider.list('user:cli:alex')` dumps returned the *identical merged list*
  (RUN_LOG first-run dump: both slots showed the same 5→6 items). The collision
  also corrupted recall quality — `recall_relationship` returned user-facts
  prose, so the model had no JSON exemplar and wrote prose into the state slot.
  Offline repro: `npx tsx companion/repro/slot-collision.ts` (mockModel +
  `sqliteMemory(':memory:')`) prints both slots listing both items.
- **Root cause:** `src/memory/withMemory.ts:21-25` — `scopeKey(slot, ctx)`
  returns the raw scope (`'global'` / `session:<id>` / function result); the
  slot `name` is never folded in. Providers key storage on that key alone
  (`src/storage/sqlite/sqliteMemory.ts:25-34`, `src/memory/providers.ts:25-38`,
  `src/memory/fileMemory.ts:23`), so any two slots resolving to the same key on
  a shared backend read/write one list. `docs/memory.md` never warns about it.
- **Suggested fix:** namespace the storage key per slot inside `withMemory`
  (e.g. `${slot.name}#${scopeKey}`) so the per-slot contract holds regardless
  of scope; alternatively, document "include the slot name in your scope
  function" prominently and have `createAgent` warn when two slots with the
  same provider object resolve to the same key. Harness workaround: distinct
  keys per slot (`user:cli:alex:facts`, `user:cli:alex:state`).

### F2: `remember_<name>` input is fixed free-text `{text}` — structured memory can't be enforced

- **Severity:** medium
- **Type:** enhancement / docs
- **Evidence:** Asked to store a relationship snapshot "as ONE raw JSON
  object", gpt-4o-mini wrote plain-prose items to the `relationship` slot in
  2/2 live runs (and once re-saved the identical sentence verbatim). A typed
  `defineTool` (`update_relationship` with a zod object input) produced clean
  structured state on every call — zod enforcement worked perfectly.
- **Root cause:** `src/memory/withMemory.ts:33-37` hardcodes
  `z.object({ text: z.string().min(1) })`; there is no slot-level schema or
  validator for item content, and no `remember` rejection path for malformed
  state.
- **Suggested fix:** support `input`/`itemSchema` on `defineMemory` (extra
  structured fields merged into `MemoryItem.metadata`, or a `format: 'json'` +
  validator that returns a tool error on bad JSON). At minimum, document the
  defineTool pattern for structured state slots.

### F3: No dedupe/upsert on `remember_*` — identical items accumulate

- **Severity:** low
- **Type:** enhancement
- **Evidence:** Live run 2 stored `"Alex's cat, Captain Crumb, knocked their
  ramen bowl off the desk."` twice (once per day); both occupy slots in the
  `maxItems` window forever. Duplicate facts are the norm in long-lived
  companions and will flood the recall block over weeks.
- **Root cause:** `src/memory/providers.ts:31-34` — `add` always appends a new
  item with a fresh id; no `update`, no exact/near-duplicate check, and the
  `recall_*` tool returns `id`s the model can see but there is no
  `forget_<name>` tool exposed for it to use them with.
- **Suggested fix:** optional `dedupe: 'exact' | 'similar'` on
  `defineMemory`/providers, an `update`/`remove` surface on slots
  (`forget_<name>` tool gated behind `expose.forget`), or documented reliance
  on `provider.remove(scopeKey, id)` from host code.

### F4: Keyword `query` matching is loose OR-matching over ≥3-letter words

- **Severity:** low
- **Type:** docs / enhancement
- **Evidence:** `recall_user_facts {query:"loud chewing"}` matches any item
  containing "loud" OR "chewing" (`src/memory/providers.ts:18-21` —
  `words.some(...)`), newest-first. Worked here, but noisy at scale (e.g.
  `query:"food"` returns every item mentioning food). Documented only
  implicitly in memory.md ("contains one of the query's words").
- **Suggested fix:** AND-matching or phrase boost for multi-word queries, or
  steer users to `sqliteVectorMemory`/`inMemoryVectorMemory` in the tool
  description when a slot holds many items.

### F5: `checkpoint_history` is wiped when a turn completes

- **Severity:** low (informational)
- **Type:** docs
- **Evidence:** After 6 successful turns the `checkpoints` and
  `checkpoint_history` tables are both empty — expected (`AgentSession` deletes
  the turn checkpoint on completion; `SqliteCheckpointStore.delete` drops
  history unless `keepHistory`, `src/storage/sqlite/stores.ts:107-111`). Only
  the `sessions` transcript row remains. Worth a sentence in
  docs/durable-execution.md so users don't read "empty checkpoints" as a
  persistence failure.

---

## What worked well

- `model: 'openrouter/openai/gpt-4o-mini'` spec resolved through
  `OPENROUTER_API_KEY` with zero config; per-run `usage` included `costUsd`
  and `cachedInputTokens` (prompt caching visible on OpenRouter).
- `session.stream()` delivered `text.delta`/`tool.*`/`run.done` cleanly and
  saved the transcript before `run.done` — restart load verified.
- `principal` plumbing into `session.stream(input, { principal })` → memory
  scope function is exactly the pattern a multi-user companion needs.
- Parallel tool calls: one turn fired 3 concurrent `remember_user_facts`
  calls; all persisted correctly.
- `SqliteStore` open→use→`close()`→reopen cycle is clean; memory, sessions
  and (transiently) checkpoints share one file as documented.
- `preGenerate` hook sees the post-recall system prompt — handy for audits;
  hook ordering (memory recall hook runs first) is as designed.
- Packed SDK + zod 4 + `ai` 7 typed cleanly (`tsc --noEmit` on the harness:
  0 errors with the repo's `skipLibCheck` tsconfig).
