# Eve audit: memory & context

Cluster: `defineMemory`/`memoryKey`, `remember_*`/`recall_*` tools, all five providers,
slot namespacing, principal scoping, compaction + context windows, `toolSearch`/deferred tools.

Method: docs first (`docs/memory.md`, `docs/compaction.md`, `docs/tool-search.md`), then source
(`src/memory/*`, `src/context/*`, `src/execution/toolSearch.ts`, `src/tools/toolSearchRank.ts`),
then live repros with `npx tsx` + `mockModel`/in-memory/file providers (no API keys).
Repro scripts: `audit/eve/repro1.ts` … `repro4.ts` (kept for re-running).

## Summary

The architecture is sound (per-key serialization, namespace isolation, atomic-ish file writes,
careful handoff/approval semantics) and the docs are unusually honest — but the *recall quality*
and *safe defaults* are embarrassing, and several footguns produce silent cross-user data leaks
or dead features:

- **Keyword recall is a substring-OR match that fails open**: a query whose words are all <3
  letters (`"AI"`, `"my id"`) returns *every* item; `"cat"` matches `"education"`; over an
  `itemSchema` slot every query hits the JSON field names so everything matches.
- **Memory is strictly append-only.** No update, no `forget_` tool, no upsert, no TTL.
  Contradictory facts ("answer in French" / "answer in English only") are co-recalled forever,
  and the doc's own `itemSchema` "structured state" example (`{trust, mood}`) degrades to a
  growing pile of stale states.
- **`fileMemory` leaks memory across users on Windows/macOS**: scope keys differing only in
  case map to the same file (reproduced on Windows: `user:Alice` and `user:ALICE` merged).
- **One corrupt memory file kills every run** — recall has no error handling, unlike
  compaction which "never fails a run".
- **Compaction silently does nothing** on the exact setup the docs recommend for local models:
  `contextWindow: 8_192` with the default `protectedTokens: 40_000` protects the whole
  conversation, so zero pruning and zero summarization happen even when over the window.
- Provider/scope validation gaps: `scope: 'user'` and `scope: () => ({...})` pass
  `defineMemory`, producing a `TypeError` at `send()` or a silent shared key `w#[object Object]`.
- The `<name>#<scope>` namespacing shipped in 66aec0f1 orphans items written under the old
  bare-scope keys; the migration break is undocumented.

Prior-round claims verified: `itemSchema` canonical JSON holds, `add()` dedupes on `text`
(across all `itemsProvider` providers and the vector provider), `<name>#<scope>` namespacing
works and old bare-scope keys really are orphaned, memory tools/recall do follow handoffs.

## Findings

### F1: Keyword recall fails open — short-word queries return *every* item; substring false positives
- Severity: high
- Persona: AI engineer
- Evidence: `src/memory/providers.ts:18-22` `select()` — `words.length === 0 ? items : filter`.
  Repro (`repro1.ts`): `list('k', { query: 'AI' })` and `{ query: 'my id' }` returned all 3
  stored items unfiltered; `{ query: 'cat' }` matched `"works in education"` (substring);
  `{ query: 'user tea preference' }` matched `"a user from Oslo"` via the single OR word "user".
- Why it makes us look bad: the default (and only non-vector) recall is loose-OR substring
  matching with a fail-open degenerate case. A model that searches memory for "its API key" or
  "my id" gets the entire memory dump instead of a filtered or empty result — worse than no
  recall. Competitors ship semantic scoring by default; our default actively misleads.
- Suggested fix: when `query` is non-empty but yields no words ≥3 chars, return `[]` (or match
  literally on the raw query). Match whole words (`new RegExp(\`\\b${word}\\b\`)`), and rank by
  hit count instead of returning all OR-matches in recency order. Document that `recall_` is
  keyword-only and push vector providers in the quick-start.

### F2: Memory is append-only — no update/forget/upsert; contradictory items are co-recalled; `itemSchema` "structured state" accumulates stale versions
- Severity: high
- Persona: AI engineer + Product manager
- Evidence: `MemoryProvider` (`src/memory/defineMemory.ts:20-31`) is `list`/`add`/`remove` only;
  `withMemory.ts` registers `remember_<name>`/`recall_<name>` but no `forget_<name>`/`update_`.
  Dedupe is exact-text (`providers.ts:38`), so a changed fact is a *new* item. Repro
  (`repro2.ts`): both `"The user wants answers in French."` and `"The user now wants answers in
  English only."` appear together in the injected `<memory>` block. The docs' `itemSchema`
  example (`{trust, mood, insideJokes}`) is exactly an upsert use case, yet remembering
  `{trust:10}` then `{trust:8}` keeps both forever.
- Why it makes us look bad: Letta/Mem0/Zep-style self-editing memory is table stakes. Our model
  cannot correct or forget anything it stored — it can only pile on contradictions, and the
  injected block then presents both to the model.
- Suggested fix: add `update(scopeKey, id, item)`/`upsert` to `MemoryProvider`, a
  `forget_<name>({ id })` tool (recall already returns `id`s), and document an itemSchema
  pattern where a primary-keyed field dedupes. Consider `add` dedupe refreshing `createdAt`
  (re-remembered facts currently keep the old timestamp and can be trimmed as "oldest").

### F3: `fileMemory` cross-user memory leak on case-insensitive filesystems
- Severity: high
- Persona: Software engineer
- Evidence: `src/memory/fileMemory.ts:23` — `fileOf = dir + '/' + encodeURIComponent(key) + '.json'`;
  percent-encoding preserves case. Repro on Windows (`repro1.ts` §5): `notes#user:Alice` and
  `notes#user:ALICE` both wrote `notes%23user%3AALICE.json` — one file, and `list()` for either
  key returns *both* users' items.
- Why it makes us look bad: a per-user memory (`scope: ({metadata}) => \`user:${userId}\`` — the
  docs' own pattern) silently merges two users' memories on the default filesystems of Windows
  and macOS. That is a data-leak class bug, not a quirk.
- Suggested fix: hash or percent-encode case-sensitively (e.g. base64url/SHA of the key, or
  encode uppercase letters too), and add a contract test with keys differing only in case.

### F4: A corrupt/unreadable memory file fails the entire run
- Severity: high
- Persona: Software engineer
- Evidence: `withMemory.ts:100-106` — `provider.list()` inside `Promise.all` with no catch;
  `HookRegistry` "throws (aborting the step) if any hook throws" (`src/execution/hooks.ts:336`).
  Repro (`repro2.ts` §7): a `notes#global.json` containing `{corrupt` made `agent.send('hello')`
  reject with a raw `SyntaxError`. Same for any transient provider failure (KV outage, sqlite
  error).
- Why it makes us look bad: an optimization feature (recall into prompt) becomes a hard
  dependency — one bad JSON file bricks the agent on every turn, in every session, forever,
  with a JSON parse error pointing nowhere near "memory". Compaction explicitly "never fails a
  run"; memory recall fails runs for less reason.
- Suggested fix: catch per-slot recall errors, `console.warn` once, and continue with an empty
  block (optionally emit a `memory.error` event). Do the same for `boundSlots`/scope-fn throws
  (wrap in `SDKError` naming the slot).

### F5: Compaction silently no-ops when `protectedTokens` ≥ context window — exactly the documented local-model setup
- Severity: high
- Persona: Software engineer + Designer
- Evidence: `src/context/compaction.ts:83` default `protectedTokens = 40_000`;
  `protectedTailStart`/`splitForSummary` (lines 114-124, 198-216) protect the whole
  conversation when `protectedTokens` covers it. Repro (`repro3.ts`): 20 prunable 3k-char tool
  results, `compactMessages(msgs, { contextWindow: 8192 })` → `pruned: 0`,
  `tokensAfter === tokensBefore`; with `protectedTokens: 2000` → 18 pruned.
  `docs/compaction.md`'s "Local and unknown models" section tells users to set
  `compaction.contextWindow: 8_192` and never mentions `protectedTokens`.
- Why it makes us look bad: the user follows our own local-model guide, the model overflows its
  window, compaction "runs" (events fire) and changes nothing — a dead feature precisely where
  it's most needed. `summarizeStrategy` has the same problem (it folds nothing when
  `protectedTokens` covers the tail).
- Suggested fix: cap effective `protectedTokens` at a fraction of `contextWindow` (e.g.
  `min(protectedTokens, contextWindow - thresholdTokens - 1)` or `0.25 * window`), or warn when
  `protectedTokens >= contextWindow * thresholdPercent`.

### F6: Scope values are never validated — garbage scope keys silently shared; invalid `scope` crashes at `send()`
- Severity: high
- Persona: Designer + Software engineer
- Evidence: `defineMemory` (`src/memory/defineMemory.ts:117-134`) validates `name` and
  `provider` but not `scope` (and not `provider.remove` — a provider without `remove` is
  accepted). `memoryKey` (line 61-65) interpolates whatever the function returns. Repro
  (`repro1.ts`): `scope: 'user'` → accepted, then `send()` throws the raw
  `TypeError: slot.scope is not a function`; `scope: () => ({bad:true})` → key
  `w#[object Object]` — *every* caller shares one memory; `scope: () => 42` → `w#42`.
  `recall.query` accepts typos (`'lastinput'` silently behaves as `'none'`, `repro4.ts`).
- Why it makes us look bad: a typo'd scope function returning a non-string — an easy mistake —
  silently pools *all users'* memories under `w#[object Object]`: a privacy bug that produces
  no error anywhere. Returning `''`/`null` quietly disables the slot.
- Suggested fix: validate `scope` in `defineMemory` (`'global'|'session'|function`); validate
  the function's return in `memoryKey` (non-empty string, warn on suspicious values like
  `[object Object]`); wrap scope-fn throws in `SDKError('LOUSHO_MEMORY_INVALID', …naming the
  slot…)`; validate `recall.query` and `provider.remove`.

### F7: `memoryKey`/`provider.add(undefined)` writes silently under the literal key `undefined`
- Severity: medium
- Persona: Software engineer
- Evidence: `memoryKey(slot)` returns `undefined` for a `'session'` slot without `sessionId`;
  docs (`docs/memory.md:125`) encourage `provider.add(memoryKey(slot)!, …)`. Repro:
  `inMemoryMemory().add(undefined)` stores under a Map key `undefined`; `fileMemory` would
  write `undefined.json`. No provider validates its `scopeKey` argument.
- Why it makes us look bad: forgetting the `ctx` argument produces a hidden shared bucket
  named "undefined" rather than an error — the `!` in our own docs makes it easy.
- Suggested fix: throw `LOUSHO_MEMORY_INVALID` in `itemsProvider`/`vectorMemory` when the key
  isn't a non-empty string, or export a `requireMemoryKey(slot, ctx)` that throws naming the
  slot and scope.

### F8: `keyedQueue` is per-provider-instance — cross-instance/process writes lose items; Windows rename can EPERM
- Severity: medium
- Persona: Software engineer
- Evidence: `src/memory/providers.ts:30` and `vectorProvider.ts:91` create one `keyedQueue` per
  provider object. Two `fileMemory({dir})` instances (or two processes sharing `dir`, or two
  `sqliteMemory` providers on one `SqliteStore`) each serialize only their own writes — both
  do load-modify-save of the whole JSON array, so last-writer-wins. Repro (`repro1.ts` §6):
  two instances adding concurrently to one key threw `EPERM: operation not permitted, rename …
  .tmp -> k2.json` on Windows (the atomic-write pattern of `fileMemory.ts:36-38` is itself
  racy on Windows: `rename` over a just-written destination can fail while a temp file is
  still flushed/scanned).
- Why it makes us look bad: the concurrency guarantee the code advertises ("two `add()`s both
  keep their item") only holds inside one provider instance — an invisible boundary. Two agent
  processes on one dir, or a worker + a CLI, corrupt memory; on Windows it can throw.
- Suggested fix: document the single-instance limit explicitly in `docs/memory.md`; for
  `fileMemory`, retry rename on `EPERM`/`EEXIST` and consider lock files or append-only logs;
  for `sqliteMemory`, do the upsert in a transaction or `INSERT … SELECT`-style merge.

### F9: Docs claim the recalled block "is not saved in the session transcript" — but it lands in `result.messages` and durable checkpoints
- Severity: medium
- Persona: AI engineer + Designer (docs accuracy)
- Evidence: `withMemory.ts:73-79` mutates `ctx.request.messages[0]` — the live run transcript
  (`generateStep` passes `state.messages` itself, per `compaction.ts:8-12`). Sessions strip the
  system message (`AgentSession.ts:831`), so `session.messages` is clean — but repro
  (`repro2.ts` §9): `send()`'s `result.messages` contains `<memory name="n">- secret fact`;
  checkpoints store `messages` verbatim (`checkpoint.ts:41`), and `setBlocks`' "replace earlier
  blocks … from a resumed run" path exists precisely because the block persists in resumed
  transcripts.
- Why it makes us look bad: the doc promise is only true for `session()` storage. Anything a
  consumer does with `result.messages` or a checkpoint (logging, eval harnesses, replay) now
  carries recalled PII — the opposite of the documented behavior and of what "not saved"
  implies for privacy.
- Suggested fix: inject the block into a per-request copy instead of the transcript, or strip
  `<memory>` blocks when persisting checkpoints; at minimum correct the doc sentence.

### F10: `<name>#<scope>` namespacing orphaned all pre-upgrade memory items — undocumented migration break
- Severity: medium
- Persona: Software engineer + Product manager
- Evidence: commit 66aec0f1 changed provider keys from the bare scope to `<slot>#<scope>`
  (`memory.test.ts:165-166` asserts `provider.list('global')` is now empty). Nothing in
  `docs/memory.md`, `docs/upgrading.md` or the CHANGELOG entry warns that items written by
  earlier alphas (under `global`, `session:s1`, …) are now invisible — the files/rows remain
  but are never read. There is also no enumeration API on items providers to find them
  (`scopeKeys()` exists only on `VectorItemStore`, for `reindex`).
- Why it makes us look bad: a user's agent quietly "forgets" everything it knew on upgrade.
  Data left behind also means GDPR deletion tools that iterate current keys would miss orphans.
- Suggested fix: document the break in upgrading.md + CHANGELOG; ship a one-shot migration
  (`provider.migrateKeys?`/`memoryItems` sweep) or at least a snippet listing legacy keys;
  consider `scopeKeys()` on the plain `MemoryProvider` interface.

### F11: `recall_<name>` strips metadata — vector `score` never reaches the model; `limit` is unbounded
- Severity: medium
- Persona: AI engineer
- Evidence: `withMemory.ts:53-55` maps provider items to `{id, text, createdAt}` — dropping
  `metadata`, which is where `vectorProvider` puts the cosine `score` (`vectorProvider.ts:69-72`)
  and where `itemSchema` slots put the parsed object. `docs/memory.md:258` advertises
  `metadata.score` but only code callers see it. The tool input (`line 52`) accepts any positive
  `limit` — `999999` is honored, a cheap context-blowup vector.
- Why it makes us look bad: the model can't tell a 0.95 match from a 0.21 marginal one, so
  semantic recall's main advantage (confidence) is invisible at the tool boundary; and a
  confused model can ask for all 5000 items.
- Suggested fix: include `metadata` (or at least `score`) in the recall tool result; clamp
  `limit` to a sane max (e.g. `min(limit, 100)`).

### F12: Missing table-stakes memory features vs competitors
- Severity: medium
- Persona: Product manager
- Evidence: no TTL/expiry on `MemoryItem`; no `clear(scopeKey)`/`deleteUser` helper — per-user
  GDPR erasure means enumerating every slot's `memoryKey` and `remove()`-ing item by item, and
  non-vector providers can't even enumerate which scope keys exist; no token budget for the
  injected block (only `recall.maxItems` item count — 10 long items can be huge); no relevance
  decay/`updatedAt` touch on dedupe; semantic recall is opt-in only (two extra providers +
  bring-your-own embedder), while the default providers are keyword substring matchers (F1).
  Also: nothing namespacing providers per agent — two agents sharing `fileMemory({dir})` and a
  slot name read each other's memories.
- Why it makes us look bad: Mem0/Zep/Letta all ship update+forget+TTL+per-user delete and
  embeddings-by-default. Our provider list looks long (5 providers) but the feature matrix per
  provider is thin.
- Suggested fix: add `expiresAt`/TTL on items filtered at `list()` time; `MemoryProvider.clear?`
  + a `agent.memory`/`forgetUser(ctx)` helper; `scopeKeys()` on all providers; a
  `recall.maxTokens` budget; per-agent provider key prefixing.

### F13: `tool_search` default ranker can't find semantically-named tools
- Severity: medium
- Persona: AI engineer
- Evidence: `src/tools/toolSearchRank.ts` — keyword overlap over name+description with a naive
  stemmer and English stop words. Repro (`repro4.ts`): `rankToolsByKeywords('share value',
  [{name:'fetch_equity_quote', …}])` → `[]`; `'statuses'` stems to `'statuse'` vs tool-name
  `'status'` → `'statu'` (no match). An empty result returns `{loaded: [], more: N}` — the model
  reads "no such tool" and either fishes with synonyms or gives up.
- Why it makes us look bad: the deferred-tools story depends on the model finding the tool;
  pure keyword search fails on synonyms — the exact thing embeddings solve. There is a `search`
  escape hatch, but no built-in embedder-backed ranker despite the SDK shipping
  `EmbeddingProvider`/`hashEmbedder` infra.
- Suggested fix: ship an optional embedder-backed `toolSearch.search` preset (cosine over
  name+description embeddings, computed once), or at least tokenize symmetrically
  (character n-gram fallback when keyword score is 0).

### F14: `compaction.start`/`compaction.done` fire on every step even when nothing compacts
- Severity: low
- Persona: AI engineer (observability DX)
- Evidence: `compaction.ts:406-446` — both events are emitted unconditionally once the request
  is over threshold, then `if (result.messages === messages && !error) return` skips only the
  mutation/`onCompaction`. A run stuck over threshold with nothing prunable (e.g. F5's small
  window, or a transcript that's all user text) emits a `compaction.start`+`done` pair per step
  with identical token counts — indistinguishable in a stream from real compaction.
- Suggested fix: emit `compaction.start` lazily (after the strategy reports a change), or add a
  `noop`/`unchanged` flag to `compaction.done`; consider a "gave up" marker after repeated
  no-ops.

### F15: `remember_<name>` description claims memory is "recalled in later conversations" — false for `scope: 'session'`
- Severity: low
- Persona: Designer
- Evidence: `withMemory.ts:36` hardcodes `"so it is recalled in later conversations"`. For a
  session-scoped slot nothing is recalled in later conversations — the model learns a wrong
  persistence model and may trust it to persist what it won't.
- Suggested fix: derive the phrase from the scope (`'session'` → "in this session", function →
  "for this scope", or accept a `rememberDescription`/`persistenceHint` option).

### F16: `<memory>` block injection sanitizes only `</memory>` — an item containing `<memory name="…">` corrupts block replacement on resume
- Severity: low
- Persona: Software engineer (robustness/security-ish)
- Evidence: `withMemory.ts:68` strips `/<\/memory>/gi` from item text but leaves opening tags;
  `BLOCK` (line 65) then parses `<memory name="([^"]*)">…</memory>` non-greedily. A stored text
  like `<memory name="notes">` survives inside the block, and on a resumed run the regex can
  match from the injected tag — leaving stale inner content outside the replaced region, or a
  stray `name` not in `names` that is preserved verbatim forever.
- Suggested fix: strip/escape `<memory` (both directions) from item text, or use a sentinel
  comment format that cannot collide with content.

### F17: Naming/API ergonomics: `inMemoryMemory()`, two unrelated `maxItems`, `memoryKey`'s optional ctx
- Severity: low
- Persona: Designer
- Evidence: `inMemoryMemory` reads like a typo (provider named "in-memory memory"); `recall.maxItems`
  (default 10, prompt budget) vs provider `maxItems` (default 1000, storage cap) share a name in
  adjacent API layers; `memoryKey(slot, ctx = {})` silently returns `undefined` for `'session'`
  scope when ctx is forgotten — the signature does not force the argument that determines
  correctness (see F7).
- Suggested fix: alias `inMemoryMemory` → `memoryInMemory`/`localMemory` (keep the old export
  deprecated); rename one of the two `maxItems` (e.g. `recall.maxItems` → `recall.items`);
  consider `memoryKey(slot, ctx)` requiring ctx when `slot.scope` isn't `'global'`.

## Verified-as-fine (prior round holds)

- `itemSchema` stores canonical sorted-key JSON in `text` + parsed object in `metadata`
  (`withMemory.ts:41-44`, test at `memory.test.ts:184-188`).
- `add()` dedupes on `text` in `itemsProvider` *and* `vectorMemory` — returning the stored item
  (keeps original `createdAt` — see F2 note).
- Two slots sharing a provider/scope are isolated (`notes#global` vs `state#global`;
  `memory.test.ts:152-167`).
- Handoff keeps the lead's memory tools + recall bound to the same keys
  (`withMemory.ts:181-185`, `createAgent.ts:879-888`); target's own slots ignored and warned.
- `remember`/`recall` tools are `transient` (no fingerprint drift on resume);
  `recall_` is `readOnlyHint` so plan mode can use it; compaction correctly preserves
  tool-call/result pairing, pinning, and rejected-summary backoff (LOU-R11).
- `tool_search` load-state derived from the transcript is elegant (survives resume/fork for
  free); the compaction-unloads-tools caveat is documented in `docs/tool-search.md`.
