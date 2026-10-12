# Eve-2 findings: durability & security fixes (commits ~#598–#611)

Adversarial re-audit of the recent durability/security work. Every finding below
reproduces deterministically on current `main`; repro scripts live in
`audit/eve2/repro/` and exit non-zero when the bug does not reproduce.

Run: `npx tsx audit/eve2/repro/<file>.ts` from the repo root.

---

## 1. Session-squatting guard is a check-then-act race — a concurrent second principal runs a turn inside a session that ends up owned by someone else

**Severity: High** (cross-user data exposure + write injection in any
multi-principal deployment that relies on the default session guard).

`ownsSession` decides "unowned + unstored → claimable" in several awaited steps,
but the claim itself (`claimSession`) is only taken at the end — and silently
no-ops when an owner appeared in between:

- `src/server/fetchRoutes.ts:364–371` — `ownsSession`: `sessionOwner()` (line
  366) → `await sessionStored(...)` (line 368, which itself awaits
  `session.load()` and `session.pending()`) → `claimSession` (line 369).
- `src/server/requestGuard.ts:191–200` — `claimSession`: `if
  (sessions.has(sessionId)) return;` — the losing claim is dropped, not
  rechecked, and the caller is never told.
- `src/server/fetchRoutes.ts:421–428` — `runChat` passes `sessionForbidden` and
  streams the turn unconditionally once the (raced) check returned undefined.
- `src/server/fetchRoutes.ts:395–406` — `claimOnCommit` re-claims in `finally`;
  the second principal's claim is again a no-op, so the session keeps the FIRST
  caller as owner even though the second caller's messages were committed.

Two `POST /chat {sessionId:'s', input}` requests for a new/unowned session, in
flight at the same time, both see "no owner, nothing stored" and both proceed.
Whoever's `sessionStored` resolves first claims the session; the other request
still runs its turn (model call, tool calls, transcript commit) inside a session
it does not own — and is then refused on every later request (`403`), while its
messages remain in the victim's transcript.

Worse, the second caller's streamed model sees the first caller's already-
committed messages: the repro shows Mallory's SSE response containing Alice's
secret (`LEAKED:ALICE_SECRET_API_KEY_9f4e`) because the model transcript for
Mallory's turn already included Alice's message.

**Repro:** `audit/eve2/repro/f1-session-squat-toctou.ts` — gates the first
`sessions.load('s')` for 150 ms so the second request's owner check completes
before the first claim lands. Output: both responses `200`,
`finalOwner = alice`, `mallorySeesAliceSecret: true`,
`malloryMessageInTranscript: true`, `sequentialMalloryStatus: 403`.

**Persona notes**

- AI engineer: prompt-injection surface — an attacker can land attacker-chosen
  user messages inside another user's durable transcript; they persist and
  shape every later turn of that session.
- PM: tenant isolation is exactly what the no-squatting change was meant to
  guarantee; the guarantee fails under the most ordinary concurrency
  (double-click, retry, load balancer fan-out).
- Software engineer: fix shape is to make check-and-claim atomic (single
  synchronous compare-and-claim keyed on `(agent, sessionId)` before any
  await), not to add more checks around it.
- Designer: the second caller gets a `200` SSE stream for a session they can
  never access again — a confusing, silent privilege drop.

---

## 2. `recordFailure()` writes `lastError` onto whatever checkpoint sits under the turn id — no lease fencing — permanently poisoning a takeover run's checkpoint

**Severity: High** (durable state corruption across processes; converts a
recoverable takeover into an unresumable failure).

`saveStepCheckpoint` is lease-fenced (`src/execution/agentRunState.ts:352–357`:
`lease?.id === sessionId ? lease.save(checkpoint) : checkpointStore.save(...)`,
and `RunLease.save` → `saveIfLeased` in `src/execution/runLease.ts:130–138`).
But the failure path is not:

- `src/session/AgentSession.ts:919–926` — `recordFailure` loads
  `<id>.turn-<n>` and saves `{ ...checkpoint, lastError,
  attempts: attempts+1 }` with a plain `checkpointStore.save`, skipping only
  `LOUSHO_SESSION_BUSY` errors. Whatever process holds the checkpoint at that
  moment gets the write merged into *its* checkpoint body.
- `src/session/AgentSession.ts:1032–1039` — `resumePending` then refuses any
  checkpoint with `lastError.retryable === false` (a 4xx/auth failure) with
  `LOUSHO_SESSION_TURN_FAILED`.

Scenario: run A of session `s` stalls past its lease (GC pause, event-loop
stall, debugger break — heartbeats can't fire, so the lease legitimately
expires). Run B takes over `s.turn-0` and writes its own checkpoint. A unstalls
and its provider call fails permanently (401). A's `recordFailure` reads B's
checkpoint and saves **B's** checkpoint body (businessState, stepIndex,
messages, `attempts`) plus **A's** `lastError {retryable:false}` — fenced saves
would have rejected here; the raw save does not. B's turn is now permanently
poisoned: every `send`/`resume` fails `LOUSHO_SESSION_TURN_FAILED` until the
user discards the turn and loses B's progress.

**Repro:** `audit/eve2/repro/f2-recordfailure-poisons-foreign-checkpoint.ts` —
a `fileStore` session whose second model call replaces the `s.turn-0`
checkpoint + lease with a "victim run" body and then throws a 401
`CompactedLLMProviderError`. Output: `businessState: 'VICTIM-RUN-B'` survives
with `lastError.retryable:false`, `attempts` incremented on the foreign body,
and the next `send` fails `LOUSHO_SESSION_TURN_FAILED`.

**Persona notes**

- AI engineer: exactly the class of bug leases exist to prevent; one unfenced
  writer negates the fencing work for the entire turn-lifecycle.
- PM: a stalled worker destroys the recovery worker's run — the takeover path
  becomes a data-loss amplifier instead of a safety net.
- Software engineer: `recordFailure` (and, relatedly, `markPaused`,
  `commit`'s `turn.checkpointStore.delete`, `busy()`) should route through the
  run's lease/`saveIfLeased` the way `saveStepCheckpoint` does, or verify the
  checkpoint is still the run's own before merging `lastError` (e.g. compare a
  recorded run id / step signature).
- Designer: the surfaced error (`turn failed ... retrying cannot fix`) names
  the wrong run's failure; operators will discard a healthy checkpoint chasing
  a 401 that belonged to a dead process.

---

## 3. The `<id>.paused` marker is written after the pause — `agent.send({sessionId})` admitted in the gap runs beside the paused session turn

**Severity: Medium** (narrow window; violates the documented EVE-0 guarantee
rather than a steady-state hole).

`pausedSessionTurn`'s marker exists so "a new turn under the session's id is
refused ... instead of running beside the paused one"
(`src/session/AgentSession.ts:1057–1060`). But the marker is written by
`markPaused()` inside `record()` — i.e. *after* the executor already persisted
the turn's `'awaiting-approval'` checkpoint and returned:

- `src/session/AgentSession.ts:1078–1081` — `record()` calls `markPaused()`
  only once the run's result arrives.
- `src/session/AgentSession.ts:1062–1067` — `markPaused` then loads `s.turn-n`
  and saves `s.paused`.
- `src/createAgent.ts:1165–1169` — `assertNotPaused` guards on that marker.
- `src/createAgent.ts:1163–1164, 1179` — `agent.send` serializes on
  `(checkpointStore, sessionId)` — a different queue than the session's own
  `(sessionStore, sessionId)` — so nothing orders it against the gap.

Between "pause checkpoint saved" and "`s.paused` written" — a window spanning
`saveStepCheckpoint` → result propagation → `record` → `markPaused` —
`agent.send(msg, {sessionId:'s'})` passes `assertNotPaused`, acquires the run
lease on `s`, and executes a full durable run beside the paused turn. Once the
marker exists the same call is correctly refused with
`SessionAwaitingApprovalError`.

**Repro:** `audit/eve2/repro/f3-paused-marker-gap.ts` — wraps
`checkpointStore.save`; when `s.paused` is about to be written it first awaits
`agent.send('side run', {sessionId:'s'})`. Output: the side run finishes
(`'side-run-finished'`) while the session turn is `awaiting-approval`, and a
post-marker send is refused (`SessionAwaitingApprovalError`).

**Persona notes**

- AI engineer: two runs under one logical session id can interleave model
  calls; the durable `s` checkpoint and the `s.turn-n` turn now race on
  resume/commit.
- PM: the pause guarantee is probabilistic under exactly the timing an async
  executor produces; rare but reachable without exotic conditions (a slow
  checkpoint store widens it arbitrarily).
- Software engineer: the marker should be written atomically with the pause
  checkpoint (same fenced save, or a two-key write inside `saveStepCheckpoint`'s
  awaiting-approval call), not in a later queue step.
- Designer: a client that retries `send` at the wrong moment gets a 200 for a
  request that should have been a typed refusal; inconsistent API semantics.

---

## Verified non-findings (checked, did not reproduce)

- `crossSiteRequest` (`src/server/requestGuard.ts:107–116`): `X-Forwarded-Host` /
  `Forwarded` are not CORS-safelisted, so a browser cross-site request cannot
  spoof them without a preflight the server must explicitly allow; `Origin:
  null` and unlisted mismatched origins are refused.
- `FileApprovalStore.resolve` (`src/storage/fileStore.ts:351–358`,
  `takeFile` 109–126): the `.claim` exclusive-create gives at-most-once claims
  across processes; `load`/`list` treat claimed records as resolved.
- `FileCheckpointStore` lease CAS (`src/storage/fileStore.ts:269–299`) serializes
  acquire/renew/release under `<file>.lock`; `saveIfLeased` is atomic under the
  same lock.
- `pausedSessionTurn` (`src/session/AgentSession.ts:277–284`) self-heals stale
  pointers; `discardPending`/`clear` clean up markers and withdraw approvals.
- `writeFileAtomic` (`src/storage/atomicFile.ts:91–107`): temp+fsync+rename;
  `.tmp` debris is excluded by `jsonFiles`' `*.json` filter.
- Approve route (`src/server/fetchRoutes.ts:503–531`): the `action ===
  'approve'` `ownsSession` bypass is compensated by `approvalOf` scoping the id
  to the session and `callerOwnsApproval` comparing principals.
