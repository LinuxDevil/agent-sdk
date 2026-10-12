# Eve audit: sessions & durability

Tarball `1.0.0-alpha.19`, Windows 11, Node 26.2. Repros are in `audit/eve/durability/` and run with `node eve/durability/<file>.mjs` from `audit/`. They are deterministic and use `mockModel`. EVE-0 still reproduces (`resume-divergence.mjs` resolves `null`).

## Summary
- **Concurrency and durability are broken together.** `send({sessionId})` has no lock (F2). The B5 BUSY check is not atomic (F4) and permanently rejects sequential use of two session objects, after tools already ran (F3).
- **Stores silently corrupt or drop data.**
  - SQLite and KV mangle bytes (F5).
  - `prune()` deletes paused turns (F6).
  - `clear()` leaves transcripts behind, and fork revives them (F8).
  - `fileStore` mixes up ids that differ only by case (F7).
- **On Workers, a KV approval can run the approved tool twice** (F9).
- **Flows corrupt shared variables, aren't cancelled on failure, and aren't durable** (F1, F12, F17).
- **Schedules and crash recovery are thin.**
  - The B14 fix isn't on main, and Worker schedule sessions grow without limit (F10).
  - There's no listing of pending turns and no drain on SIGTERM (F15).
  - One bad turn bricks a session (F11).

## Findings

### DUR-F1: Flow `parallel`/`forEach` branches share one `variables` object, so `{{item}}` gets overwritten
**Severity** high · **Lens** SWE / AI eng · **Type** bug
- **Evidence:** `d11-flows-parallel.mjs`: `customers charged: ["dave","dave","erin","erin","frank","frank"]`.
- **Root cause:** `src/flows/FlowExecutor.ts:515-517,550-554,642-644,695,912`.
- **Fix:** give each branch and each iteration its own scope, and merge back only declared outputs.

### DUR-F2: Concurrent `agent.send(msg, {sessionId})` loses a turn
**Severity** high · **Lens** SWE / PM · **Type** bug
- **Evidence:** `d2-send-sessionid-race.mjs`: both calls return ok, but one turn is lost (memory and file stores).
- **Root cause:** `src/createAgent.ts:1021-1025` → `AgentExecutor.execute`, which bypasses the `sessionQueues` in `AgentSession.ts:178`.
- **Fix:** route these calls through the per-(store, id) queue, and check a revision on the final save (throw `LOUSHO_SESSION_BUSY` if it changed).

### DUR-F3: A stale session object fails `LOUSHO_SESSION_BUSY` forever, after its tools ran
**Severity** high · **Lens** SWE / Design · **Type** bug
- **Evidence:** `d13-stale-session-object.mjs`:
  - Sequential use of two objects makes the second one fail BUSY on every retry.
  - The email is sent, but the transcript has no tool result.
- **Root cause:** `src/session/AgentSession.ts:365,699-703,854-864`.
- **Fix:** re-read the transcript at turn start and in `load()`. Check the base before running. Keep the completed tool prefix when the commit check fails.

### DUR-F4: The BUSY check is a non-atomic load, compare, save
**Severity** medium · **Lens** SWE · **Type** bug
- **Evidence:** `d3-busy-toctou.mjs`: two `SqliteStore` or `fileStore` instances both return ok, and one turn is lost.
- **Root cause:** `AgentSession.ts:839,854-856`; `session/sessionStore.ts:40-47` (no compare-and-swap).
- **Fix:** add an optional `saveIf(id, revision, msgs)`.

### DUR-F5: Image/file bytes corrupted across SQLite approvals and KV checkpoints/approvals
**Severity** high · **Lens** AI eng / SWE · **Type** bug
- **Evidence:** `d6-sqlite-approval-bytes.mjs` and `d7-kv-bytes.mjs` both show bytes coming back as `{"0":137,...}`.
- **Root cause:**
  - `src/storage/sqlite/stores.ts:143` (plain `JSON.stringify` against `decodeBytes` at `:37`)
  - `src/deploy/kvCheckpointStore.ts:154,182,199`
  - `src/deploy/kvStore.ts:97,104,109`
- **Fix:** use `encodeBytes`/`decodeBytes` everywhere, and add a store contract test that round-trips a `Uint8Array`.

### DUR-F6: `SqliteStore.prune()` deletes paused turns whose approval is unresolved
**Severity** high · **Lens** SWE / PM · **Type** bug
- **Evidence:** `d8-prune-pending.mjs`: resolving the approval afterwards runs the refund, throws BUSY and leaves an empty transcript.
- **Root cause:** `src/storage/sqlite/SqliteStore.ts:116-119`. Its JSDoc promises unresolved approvals are kept.
- **Fix:** exclude awaiting-approval checkpoints and their sessions from pruning. Make the continuation fail with `LOUSHO_APPROVAL_ORPHANED`.

### DUR-F7: `fileStore` session ids collide on case-insensitive filesystems
**Severity** high · **Lens** SWE · **Type** security
- **Evidence:** `d5-session-id-filesystem.mjs`: session `alice` reads `Alice`'s SSN.
- **Root cause:** `session/sessionStore.ts:99-102`, `storage/fileStore.ts:138-141`, `sessionId.ts:9`.
- **Fix:** use a case-safe, reversible file-name encoding, with a fallback read of the legacy name.

### DUR-F8: `clear()` leaves transcript copies in checkpoint history; fork revives them
**Severity** high · **Lens** SWE / PM · **Type** privacy
- **Evidence:** `d15-clear-leaves-history.mjs`: `agent.fork('patient-9.turn-4')` recovers the diagnosis after `clear()`.
- **Root cause:** `AgentSession.ts:553-558,842`.
- **Fix:** delete every `<id>.turn-<n>` along with its history. Add `agent.deleteSession(id)`.

### DUR-F9: A KV approval resolved twice runs the approved tool twice
**Severity** high · **Lens** SWE · **Type** security / bug
- **Evidence:** `d17-kv-double-approve.mjs`: the payout runs 2× on KV and 1× on file.
- **Root cause:** `src/deploy/kvStore.ts:87,100-105` (get then delete, no claim).
- **Fix:** document the race, pass the approval id as an idempotency key, and add an atomic Durable Object (or D1) claim store.

### DUR-F10: Schedules: B14 isn't on main, and Worker schedule sessions grow without limit
**Severity** medium · **Lens** AI eng / SWE · **Type** regression
- **Evidence:** `d9-schedules-sessions.mjs`:
  - `startSchedules` writes no session.
  - `handleScheduled` sends 2, 20 and 60 messages on days 1, 10 and 30.
- **Root cause:** `src/schedules/startSchedules.ts:252`, `src/schedules/scheduled.ts:56`.
- **Fix:** use one session per fire on both paths, and offer an opt-in shared session with compaction.

### DUR-F11: One deterministic provider error bricks a checkpointed session
**Severity** medium · **Lens** AI eng / Design · **Type** bug / DX
- **Evidence:** `d1-poison-turn.mjs`: every later `send()` replays the poisoned turn and fails with the same 400.
- **Root cause:** `AgentSession.ts:749-754`.
- **Fix:** record the error and attempt count on the checkpoint. For non-retryable errors, throw `LOUSHO_SESSION_TURN_FAILED` and name `discardPending()`.

### DUR-F12: A failing `parallel` branch doesn't cancel its siblings
**Severity** medium · **Lens** SWE · **Type** bug
- **Evidence:** `d11` (b). Duplicate of MA-F11; fix both together.
- **Root cause:** `FlowExecutor.ts:550-554`.
- **Fix:** see MA-F11.

### DUR-F13: `fileStore` throws a raw Windows `EPERM` under concurrent use
**Severity** medium · **Lens** SWE · **Type** bug
- **Evidence:** `d4-windows-eperm.mjs`: 20 of 250 operations fail with EPERM.
- **Root cause:** `session/sessionStore.ts:126`, `storage/fileStore.ts:95,165`.
- **Fix:** retry the rename with backoff, and wrap failures as `LOUSHO_STORAGE_FAILED`.

### DUR-F14: `SqliteStore` freezes the event loop for up to 5 s under lock contention
**Severity** medium · **Lens** SWE · **Type** perf
- **Evidence:** `d16-sqlite-blocks-loop.mjs`.
- **Root cause:** `storage/sqlite/connection.ts:301,319,342-353`.
- **Fix:** use a short busy timeout with async backoff, and map lock errors to `LOUSHO_STORAGE_BUSY`.

### DUR-F15: No crash recovery: interrupted turns can't be listed, and SIGTERM doesn't drain
**Severity** medium · **Lens** PM / SWE · **Type** enhancement / bug
- **Root cause:** `checkpoint.ts:206-212`, `sessionStore.ts:40-47`, `deploy/adapters/node-server.ts:167-169`, `deploy/nodeServer.ts:55`.
- **Fix:** add `checkpoints.list({status})`, `agent.pending()` and `agent.recover()`, and drain gracefully on SIGTERM.

### DUR-F16: Two conversation models share one id space; the schedules docs point at the wrong one
**Severity** low · **Lens** Design / PM · **Type** docs / DX
- **Evidence:** `d18-schedule-session-invisible.mjs`.
- **Root cause:** `createAgent.ts:1033-1037`.
- **Fix:** unify the two models, or reject an id used both ways. Fix the docs.

### DUR-F17: Flows have no durability
**Severity** medium · **Lens** PM · **Type** enhancement
- **Fix:** checkpoint `{variables, completedStepIds}` per node, and add resume, approval pause and step retry.

### DUR-F18: `WebhookTriggerAdapter` buffers an unbounded body before auth
**Severity** medium · **Lens** SWE · **Type** security / DoS
- **Evidence:** `d10-trigger-body-dos.mjs`: a 300 MB POST grows RSS by about 905 MB, then gets a 401.
- **Root cause:** `triggers/adapters/WebhookTriggerAdapter.ts:68-77,98,110`.
- **Fix:** use the 1 MB capped reader and return 413. Stop echoing the error message.

### DUR-F19: `fork()` fails for valid ids of 122–128 characters
**Severity** low · **Lens** Design · **Type** bug
- **Evidence:** `d14-fork-edge.mjs`.
- **Root cause:** `AgentSession.ts:626-630`.
- **Fix:** fall back to a hashed fork id.

### DUR-F20: Cron jobs in the 02:00 hour silently skip the spring-forward day
**Severity** low · **Lens** Design · **Type** docs
- **Evidence:** `d19-cron-dst.mjs`.
- **Root cause:** `triggers/cronExpression.ts:240-248`.
- **Fix:** run at the first instant after the gap, or document the skip.

## Verified non-issues
- Crash mid-turn resume works.
- Approval on a cached session object works.
- File and SQLite approval claims are atomic.
- Cron fall-back fires once.
- Windows device names work as session ids.
- A first-call provider error doesn't poison the session.
- SQLite ids are case-sensitive.
- Schedule non-overlap holds.
