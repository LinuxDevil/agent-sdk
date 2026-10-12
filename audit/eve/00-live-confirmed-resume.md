# EVE-0 — `agent.resume(id)` silently no-ops on a paused channel session

**Severity: high** | **Status: FIXED upstream — re-verified on main @ f4c8eb10**

The fix rounds added a session-level paused marker (`<id>.paused.json`,
AgentSession.ts `pausedTurnKey`/`pausedSessionTurn`), so a pending
approval is discoverable regardless of transcript bookkeeping. All three
repros now correctly throw `SessionAwaitingApprovalError`; the stale
marker is lazily deleted on the next turn. (Original report below.)

Found during live re-verification: `incident-responder` run against
`openrouter/openai/gpt-4o-mini` — the durable-store check
"session checkpoint marked awaiting-approval (resume refuses)" FAILED:
`commander.resume('inc-7001')` resolved `null` while
`checkpoints/inc-7001.turn-0.json` sat on disk with
`status: "awaiting-approval"`.

## Root cause

`mountChannels(agent, [channel])` without `options.store` gives channel
turns a **MemorySessionStore transcript** (channelCore.ts:101), while
`withDefaultStores` backfills `checkpointStore`/`approvalStore` from the
agent's durable `fileStore`.

The approval-continuation path (`approvals.resolve` → resume of the
checkpointed turn) commits the finished transcript through a session bound
to the **durable** sessions store. Net effect after the first completed
channel turn:

- `sessions/<id>.json` on disk = the finished transcript (length L > 0),
  frozen — the live channel keeps writing to memory.
- Every subsequent channel turn sees transcript length 0 → checkpoints
  `<id>.turn-0` (overwriting the previous turn's checkpoint each time).
- `agent.resume(id)` → `session({id}).resume()` → `pendingCheckpoint()`
  derives `turn-<L>` from the **durable** transcript → no such file →
  returns `null`. The real awaiting-approval checkpoint at `turn-0` is
  invisible to it.

`loadRunState`'s `SessionAwaitingApprovalError` guard (LOU-U8) is never
reached. No error, no signal — the caller just gets `null` and the paused
turn is silently abandoned.

## Wider blast radius (same root cause)

The pause is discoverable only via `<id>.turn-<transcript.length>` under
the *caller's* transcript view — there is no session-level "paused"
marker. Verified siblings:

- `repro/paused-send-overlap.mjs`: `agent.send(msg, {sessionId:'chat'})`
  while `chat.turn-0` awaits approval → **runs a full second turn**
  (`finishReason: stop`), leaving `chat.json` + `chat.turn-0.json`
  coexisting in the checkpoint dir. The paused approval is not a lock.
- `repro/paused-session-send.mjs`: `session({id:'chat'}).send(...)` on the
  durable view while the channel turn is paused → runs a new turn and
  commits to the durable transcript, bypassing the pending approval
  entirely.

So "paused for approval" means only: *the same caller, using the same
transcript store, with the same transcript length* will see it. Everyone
else can run new work under the same session id mid-approval.

## Secondary damage

- Transcript divergence is permanent: durable `sessions/<id>.json` never
  sees later channel turns; the channel's memory transcript is lost on
  restart. "Durable sessions" is false for channel traffic by default.
- `turn-0` checkpoint gets clobbered by each new turn, destroying the
  checkpoint-history/fork story for the session.

## Repro

`audit/eve/repro/resume-divergence.mjs` — mock model, no network:
1. Completed turn on durable session `chat` → `sessions/chat.json` (2 msgs).
2. Channel-shaped session (`agent.session({id:'chat', store: new MemorySessionStore()})`)
   pauses on a `needsApproval` tool → `chat.turn-0` awaiting-approval on disk.
3. `agent.resume('chat')` → **resolved null** (expected
   `SessionAwaitingApprovalError`).

## Fix direction

Either:

- `resume()`/`pendingCheckpoint()` should consult the checkpoint store's
  pending entries for the session prefix (`<id>.turn-*`) rather than only
  `<id>.turn-<transcript.length>` — an awaiting-approval checkpoint should
  ALWAYS produce `SessionAwaitingApprovalError` regardless of transcript
  bookkeeping; **and/or**
- channel sessions should default to the agent's durable transcript store
  so the two views can't diverge (the in-memory default exists so channel
  demos work without a store — but silently diverging from the checkpoint
  store is the bug); at minimum `mountChannels` should warn when the agent
  is durable and no channel store is given.
