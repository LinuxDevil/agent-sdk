# Eve-2 adversarial audit — runtime/tools fix rounds

Scope: defects in code touched by the recent fix rounds — `e5f5731b` (abort/`abortReason`),
`3733b4dd`/`5bc2bc8a` (multi-approval pauses, sub-agent resume), `14541d03` (provider-failure
surfacing, timeouts, tool errors, serialization), `677eae1d` (ai-7 tool errors, typed configs),
`247ff79e` (typed custom providers, JSON replies to streams), `4ef697a7` (OpenRouter
search/reasoning reporting). All evidence below is from current `main`; every repro is
deterministic and runnable from the repo root with `npx tsx audit/eve2/repro/<file>.ts`.

| # | Finding | Severity | Repro |
|---|---------|----------|-------|
| 1 | Session ownership is a check-then-act race — a concurrent request runs inside another user's session and receives their data | Critical | `f1-session-squat-toctou.ts` |
| 2 | `recordFailure` writes `lastError` onto a foreign run's checkpoint without lease fencing — permanently poisons it | High | `f2-recordfailure-poisons-foreign-checkpoint.ts` |
| 3 | The `<id>.paused` marker lands after the pause checkpoint — a durable run is admitted beside the paused turn in the gap | High | `f3-paused-marker-gap.ts` |
| 4 | Sub-agent grouped approvals run schema-invalid edited args | High | `subagentGroupEditedArgs.ts` |
| 5 | Abort during tool execution never settles the run (two call sites) | High | `abortDuringToolExecution.ts`, `abortDuringResumedTool.ts` |
| 6 | A re-paused run's checkpoint drops `approvalIds` — durable state names 1 of N approvals | Medium-High | `rePausedSubagentCheckpointIds.ts` |
| 7 | `uniqueToolCallIds` splits one streamed call into phantom calls when deltas repeat `id` without `index` | Medium | `streamToolCallIdRewrite.ts` |
| 8 | `isStreamingRequest` regex false-positive rewrites a JSON reply into SSE | Medium | `streamRegexFalsePositive.ts` |

---

## 1. Session ownership is a check-then-act race — a stranger runs a turn inside another user's session

**Repro** (`audit/eve2/repro/f1-session-squat-toctou.ts`): two concurrent `POST /chat` calls for the
same unowned session id, from two different principals (`alice`, `mallory`). Alice's transcript
load is delayed inside `sessionStored`, so mallory's owner check also sees "unowned".

```
"aliceStatus": 200, "malloryStatus": 200,
"finalOwner": { "id": "alice", ... },
"mallorySeesAliceSecret": true,        <- mallory's SSE stream carried alice's user message
"malloryMessageInTranscript": true,    <- mallory's input persisted in alice's transcript
"sequentialMalloryStatus": 403, "malloryReadAfter": 400
BUG REPRODUCED: concurrent squat — mallory ran a turn in a session now owned by alice
```

**Cause.** `ownsSession()` (`src/server/fetchRoutes.ts:364-371`) is read-check-act with no atomicity:

1. `sessionOwner()` → `undefined` for both callers;
2. `sessionStored()` (`fetchRoutes.ts:378-387`) → `false` for both (the loser's load is still in flight);
3. `if (claim) claimSession(...)` — `claimSession()` (`src/server/requestGuard.ts:191-200`)
   **silently no-ops** when the id is already claimed (`if (sessions.has(sessionId)) return;`, line 194);
4. `ownsSession` then `return true` unconditionally (line 370) — the caller whose claim was just
   refused is allowed anyway.

Both turns then stream concurrently over the same session. `claimOnCommit()`
(`fetchRoutes.ts:395-406`) re-claims at commit but equally can't displace an existing claim, so the
un-owned caller's turn completes, commits, and its full event stream (the other user's transcript,
replayed to the model and back) goes to the wrong principal. After the race, everything behaves
"correctly": mallory gets 403 on new turns and can't even read — which makes the leak hard to spot.

**Why it matters.** This is an authorization boundary, not a glitch: a first-touch race lets an
unauthenticated-to-this-session principal inject messages into and exfiltrate content from a
session that the very next request correctly refuses them.

- **AI engineer:** the guard's contract ("unowned session is claimed by a turn") is only eventual; the claim must be atomic — `claimSession` should report whether it won and `ownsSession` must deny on loss, or the whole check must run under a per-session lock.
- **PM:** multi-tenant deployments promise session isolation; one unlucky concurrent first touch breaches it — this is a report-a-security-advisory class bug, not a UX wart.
- **Software engineer:** also note `claimOnCommit` re-claims without checking — even an atomic first claim leaves the commit path needing the same "did I win?" answer before streaming.
- **Designer:** authorization failures must be fail-closed; a claim that "didn't take" can never surface as a successful stream.

## 2. `recordFailure` stamps a failure onto a foreign run's checkpoint — permanently poisoning it

**Repro** (`audit/eve2/repro/f2-recordfailure-poisons-foreign-checkpoint.ts`): run A of session `s`
stalls mid-turn; a second run takes over the `<s>.turn-0` lease and writes its own checkpoint.
A's provider call then fails permanently (401). A's `recordFailure` loads — B's checkpoint — and
saves it back with A's `lastError` (`retryable: false`) and `attempts+1`.

```
"businessState": "VICTIM-RUN-B", "attempts": 8,
"lastError": { "code": "LOUSHO_PROVIDER_REQUEST_FAILED", "retryable": false, ... },
"hasVictimMarker": true,
"nextSendError": "LOUSHO_SESSION_TURN_FAILED"   <- B's healthy turn is now unresumable
```

**Cause.** `recordFailure()` (`src/session/AgentSession.ts:919-926`) does a raw
`turn.checkpointStore.load` + `save` of `{ ...checkpoint, lastError, attempts+1 }` — with none of
the run-lease fencing `saveStepCheckpoint` uses (`RunLease.save` → `saveIfLeased`). It checks only
that the loaded checkpoint is `in-progress` — nothing verifies the checkpoint belongs to the run
that failed. The next `send()` hits `resumePending`
(`AgentSession.ts:1032-1040`): `failed.retryable === false` → `LOUSHO_SESSION_TURN_FAILED`, forever —
the victim run's only way out is `discardPending()` (losing its work) or an explicit `resume()`.

**Why it matters.** A stale/zombie run (the exact scenario run leases exist for) can permanently
poison the live run's durable state with a failure the live run never had. Unfenced writes are the
bug class leases were added to prevent; this writer was left out.

- **AI engineer:** every checkpoint writer must go through the lease (or compare-and-store on a run identity field); `recordFailure` is the one path that skips it.
- **PM:** rare but catastrophic for durable sessions — a healthy long-running turn becomes unrecoverable because an unrelated stalled attempt died.
- **Software engineer:** minimal fix — load-and-save under the run's lease (`saveIfLeased`), or stamp `runId` on checkpoints and refuse the write on mismatch.
- **Designer:** n/a — invisible corruption; only shows as "this session can never continue" to the end user.

## 3. The `<id>.paused` marker lands after the pause checkpoint — a durable run is admitted beside the paused turn

**Repro** (`audit/eve2/repro/f3-paused-marker-gap.ts`): a `checkpointStore.save` wrapper defers the
`s.paused` marker write and fires `agent.send(msg, { sessionId: 's' })` in the gap.

```
"pausedFinishReason": "awaiting-approval",
"sideRun": { "finishReason": "stop", "text": "side-run-finished" },   <- ran beside the paused turn
"afterMarkerError": "SessionAwaitingApprovalError"                   <- refused only afterwards
```

**Cause.** Ordering in `AgentSession.record()` (`src/session/AgentSession.ts:1078-1081`): the
executor already saved the turn's `'awaiting-approval'` checkpoint when `record()` runs;
`markPaused()` (`AgentSession.ts:1062-1067`) then writes the `<id>.paused` pointer in a *second*,
non-atomic save. The durable-run guard `assertNotPaused`
(`src/createAgent.ts:1166-1167`) consults only that pointer via `pausedSessionTurn`
(`AgentSession.ts:277-283`) — so between "pause checkpoint exists" and "marker exists", a
`agent.send(msg, { sessionId })` under the session's id sees no marker and runs a complete turn
beside the paused one: two live turns mutating one transcript id, exactly what the marker
(Eve EVE-0) exists to refuse.

**Why it matters.** The pause marker is the mechanism that keeps a resumed/durable run from
double-driving a session that waits on a human. The gap is small in wall-clock terms but
deterministic under any store latency — and a crashed process between the two writes leaves the
marker absent *permanently* while the awaiting checkpoint persists, so a post-restart durable send
is admitted beside a pending approval.

- **AI engineer:** the marker and the pause checkpoint must be one write (or the guard must also treat an awaiting-approval turn checkpoint as paused); two durable writes for one logical transition is the bug.
- **PM:** approval-paused sessions can silently double-execute work — for gated tools that's "the human said wait, the system ran anyway" in a narrow but real window, wider after a crash.
- **Software engineer:** `pausedSessionTurn` could also scan `<id>.turn-*` for `status === 'awaiting-approval'` instead of trusting the pointer — defense in depth for the crash window.
- **Designer:** "waiting for approval" must be a state the moment the run pauses, not a second I/O later.

## 4. Sub-agent grouped approvals execute schema-invalid edited arguments

**Repro** (`audit/eve2/repro/subagentGroupEditedArgs.ts`): a sub-agent pauses on two
approval-requiring calls. Resolve the second member with `approved: true, args: { a: "not-a-number", b: 4 }`
where the tool's zod schema requires `a: number`.

```
after resolving id2 (edited args): awaiting-approval [ '37f41197-…' ]
final: stop | tool args seen: [{"a":1,"b":2},{"a":"not-a-number","b":4}]
BUG CONFIRMED: tool executed with schema-invalid args on a sub-agent grouped approval
```

**Cause.** `groupDecision()` short-circuits edited-arg validation for sub-agent snapshots:

- `src/execution/resume.ts:627` — `args = snapshot.subagent ? decision.args : (await withEditedArgs(claimed, decision, toolRegistry, observed)).pending.args;`
- `withEditedArgs()` (`resume.ts:480,487-488`) is the only place `decision.args` goes through `validateToolArguments()` — and it also early-returns for `snapshot.subagent` (line 480), so no path validates a sub-agent's edited args.
- `runDecidedGroup()` (`resume.ts:681-684`) then installs `decided.args` on the pending call and rewrites the transcript; the tool runs with them.

The code comment ("a sub-agent's call: by the sub-agent's resume") assumes the sub-agent's own
resume validates — it does not; the repro proves the invalid object reaches `execute()` verbatim.

**Why it matters.** "Approve with edits" (TOOLS-F19) is a review gate: the human edits what the
tool will do. For grouped sub-agent approvals the schema gate silently disappears — a tool runs
with arguments it was declared unable to accept (wrong types, missing required fields, prototype-shaped
keys), while the approval record and transcript show the reviewer-signed-off args.

- **AI engineer:** the tool-call contract (args ≅ zod schema) is violated inside the runtime; downstream model turns see results produced by inputs that were never legal.
- **PM:** "the human edited and approved it" is not true — the executed call differs from what validators guarantee on the single-call path; audit trails mislead.
- **Software engineer:** fix is to run `validateToolArguments` for `snapshot.subagent` decisions too (or route through `withEditedArgs`), plus a regression test covering grouped sub-agent edits.
- **Designer:** a UI that lets reviewers tweak grouped child-agent calls must not promise "edited args are checked"; today the edit box is a bypass.

## 5. Abort during tool execution never settles the run

**Repro** (`audit/eve2/repro/abortDuringToolExecution.ts`): a tool that observes `ctx.signal`
(logs it) but never settles; abort 150 ms in.

```
signal aborted at ~150ms; tool saw abort: true
send() outcome: STILL PENDING after 1200ms - RUN HUNG
```

**Repro 2** (`audit/eve2/repro/abortDuringResumedTool.ts`): same tool behind `needsApproval`;
abort the signal passed to `approvals.resolve()` while the approved call runs — the resume hangs too.

```
resolve() outcome: STILL PENDING after 1200ms - RESUME HUNG
```

**Cause.** The abort fix round (`e5f5731b`) raced the *model* call (`abortable()`,
`generateStep.ts:235-243,308-312`) but never raced tool promises:

- `src/execution/toolCallExecution.ts:593` — `await executeToolWithSandboxGuard(...)`;
- `src/execution/toolBatch.ts:147` — `await Promise.all(this.running)` waits for every in-flight call; abort only prevents *new* launches;
- `src/execution/sandboxGuard.ts:70` — `executeToolWithSandboxGuard` passes the signal to the tool but does not race it;
- `src/execution/resume.ts:1473-1481` — `executeApprovedTool` has the identical gap for post-approval executions.

A signal-aware-but-nonterminating tool (async work stuck on a resource, a tool that cancels
cleanup but not the operation, a wedged SDK call that swallows the signal) leaves `send()` /
`approvals.resolve()` pending forever — `runStepOrAbort` only sees the abort after the step settles.

**Why it matters.** Abort is the run's emergency stop; the one guarantee it must give is that the
returned promise settles. Today a single wedged tool nullifies it — and the second repro shows the
least-tested resume path is broken the same way.

- **AI engineer:** cooperative cancellation is a convention, not a mechanism; any third-party tool that ignores or delays honoring `signal` DoSes the agent loop. Tool awaits need the same `abortable()` treatment model calls got.
- **PM:** "stop" buttons and timeouts in consuming apps appear broken — the UI reports cancelled, the run burns tool-side resources indefinitely.
- **Software engineer:** race each tool promise against `options.signal` (batch and `executeApprovedTool`), and document that the tool itself may outlive the run.
- **Designer:** progress UIs need a "stopping…" state that can actually end; a cancel affordance that can hang forever teaches users it doesn't work.

## 6. A re-paused run's checkpoint under-reports the approval group

**Repro** (`audit/eve2/repro/rePausedSubagentCheckpointIds.ts`): resume a held-subagent pause;
inside the resumed turn the sub-agent pauses on a *new* two-call approval group. The returned
`ExecutionResult` lists both ids; the durable checkpoint lists one.

```
second pause (resume result): awaiting-approval [ 'c46738b2-…', '1aab09da-…' ]
checkpoint after re-pause   - status: awaiting-approval approvalId: c46738b2-… approvalIds: undefined
checkpoint after re-pause   - pausedApprovalIds: [ 'c46738b2-…' ]
```

**Cause.** Two writers, inconsistent fields:

- `markGroupPending()` (`src/execution/resume.ts:645-658`) — used when a *decision* leaves the
  group undecided (`resume.ts:260`) — correctly writes `approvalIds` when >1.
- `markAwaitingApproval()` (`src/execution/resume.ts:1298-1313`) — used when the resumed run
  *pauses again* (`resume.ts:338` sub-agent pause; `resume.ts:349` held-sub-agent `pauseAgain`) —
  writes `approvalId` but **never** `approvalIds`, even though `paused.approvalIds` carries them.

Consumers read the checkpoint faithfully: `pausedApprovalIds()`
(`src/execution/checkpoint.ts:176-178`) prefers `approvalIds`, and the approvals facade
(`src/createAgentApprovals.ts:347`) iterates `current.approvalIds ?? [current.approvalId]` —
so after a restart (or any fresh reader of the checkpoint store) only the first approval is
discoverable; the rest sit orphaned in the approval store, resolvable only by an id nobody was told.

**Why it matters.** The live result and the durable record disagree about what the run waits on.
Anything driven by the checkpoint — session recovery, an approval inbox, `pendingApprovals()` —
sees a strict subset of the pause.

- **AI engineer:** the group's multi-decision state machine still works (siblings are claimed via the stored snapshot group), but a restarted orchestrator approving "what the checkpoint lists" will under-decide; behavior diverges between in-process and durable paths.
- **PM:** approval backlogs/queues silently lose items on crash/restart — a compliance-shaped data-loss bug in the pause feature that was just shipped.
- **Software engineer:** one-line class of fix — persist `approvalIds` in `markAwaitingApproval` exactly like `markGroupPending` does (and add a checkpoint-diff assertion to the re-pause tests).
- **Designer:** a "pending approvals" list must not depend on which path produced the pause; today the same UI shows 1 item live-resumed vs 2 items when it read the run result.

## 7. `uniqueToolCallIds` fragments a streamed call whose deltas repeat `id` without `index`

**Repro** (`audit/eve2/repro/streamToolCallIdRewrite.ts`): feed the exported rewrite three SSE
payloads of one streamed call whose deltas repeat `id: "call_1"` and omit `index`.

```
call ids after rewrite: [ 'call_1', 'call_1_2', 'call_1_3' ]
control (with index):     [ 'call_9', 'call_9', 'call_9' ]
```

**Cause.** `ToolCallIds.assign()` (`src/providers/providerFetch.ts:343-356`) only recognizes a
*repeated* streamed id when it can key it by `${choice.index}:${call.index}` (line 348). With
`call.index` absent, every delta falls into `idFor(id, undefined)` (`providerFetch.ts:359-367`),
sees the id already in `used`, and mints a fresh suffix. The doc comment (lines 309-315) claims
"a stream that repeats a call's id on each of its deltas keeps the id it was given first" — true
only when `index` is present. OpenAI always sends `index`; but this rewrite exists precisely for
non-conforming OpenAI-compatible servers ("and Gemini behind proxies"), which are exactly the
servers likely to omit it.

**Impact.** One logical tool call becomes N calls with ids `call_1…call_1_N`, each holding one
fragment of the arguments JSON — none parses. The model is billed phantom tool calls whose args
fail validation (or worse, a fragment that *does* parse executes a wrong call).

- **AI engineer:** the dedup must key repeated ids even without `index` (e.g. remember the last unindexed id per choice delta) — otherwise the "normalize quirky servers" feature *creates* the corruption it fixes.
- **PM:** on affected gateways, streaming tool use degrades to validation errors or wrong calls with no user-visible explanation.
- **Software engineer:** unit-test matrix needs: delta repeats id, no index → same id out; distinct ids, no index → distinct out (current code already passes the second).
- **Designer:** nothing user-facing to add — but tool-call displays should expect duplicate/phantom calls from this provider family until fixed.

## 8. `isStreamingRequest` regexes the raw body — a nested `"stream":true` corrupts a non-streamed reply

**Repro** (`audit/eve2/repro/streamRegexFalsePositive.ts`): a non-streaming `generate()`-shape
request whose body carries an object field `providerOptions: { gateway: { stream: true } }`
(serializes as a literal `"stream":true` — unlike the same text inside a string, which JSON-escapes
as `\"` and misses the regex).

```
response content-type: text/event-stream
response body starts: "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",…"
```

**Cause.** `isStreamingRequest()` (`src/providers/providerFetch.ts:216-219`) decides "this was a
streamed request" by matching `/"stream"\s*:\s*true/` against the *entire raw request body*, not the
parsed top-level field. Downstream, `watchedResponse()` (`providerFetch.ts:235-246`) sees
`streaming: true` + a JSON (non-SSE) reply and replays it through `chatCompletionAsStream()` —
rewriting the body to `data: …` events and the content-type to `text/event-stream`. The AI SDK's
non-streamed `generateText()` then fails to parse SSE as JSON: the call errors out.

Any nested boolean `stream: true` in the serialized request triggers it — provider-option
passthroughs, gateway metadata, a tool's `providerOptions`. The trigger is realistic precisely
because providers/options are free-form JSON.

- **AI engineer:** detection must parse the body once (`JSON.parse(init.body).stream === true`) rather than regex raw text — content-aware sniffing of serialized JSON is always false-positive-prone.
- **PM:** a feature flag or option object named `stream` in user config can break every non-streamed call through the built-in providers — confusing, environment-specific failures.
- **Software engineer:** also note the asymmetry — `"stream": true` inside a *string* is escaped and missed, so the check is doubly inconsistent; a parsed check fixes both directions.
- **Designer:** n/a — but error surfacing should point at the request, not the response parse, when this trips.

---

## Verified not-a-bug (checked, no repro produced)

- **Held-sub-agent pause chains** (`heldSubagentOwnApproval.ts`): a sub-agent pausing for its own
  approval inside a paused parent resumes correctly through three pauses — `OK`.
- **Signal-ignoring model providers / stuck streams:** every model call — streamed or not — is
  wrapped in `abortable()` (`generateStep.ts:235-243,308-312`), so a provider that never settles or
  a `fullStream` that never yields still loses to `options.signal`. The gap is tool execution
  (finding 5), not generation.
- **Mixed approve/deny in a group:** `runDecidedGroup` (`resume.ts:670-692`) runs approved members
  and writes rejection results for denied ones in call order; `claimWaitingSiblings` +
  `withGroupLock` (`resume.ts:513-559,566-587`) serialize concurrent decisions and throw
  `LOUSHO_APPROVAL_CONFLICT` on a lost race — sound by inspection.
- **200-OK envelope failures / mid-stream errors:** `chatCompletionFailure`
  (`providerFetch.ts:274-301`) catches `error` bodies and `finish_reason:"error"` in both JSON and
  SSE replies; `failedStep` (`aiSdkCompat.ts:198-207`) re-catches it inside the SDK result.
- **OpenRouter reasoning/search gating:** reasoning chunks/blocks and the `web_search` hosted call
  are emitted only when the call requested them (`OpenRouterProvider.ts:480,521,554-567`);
  `withObservedUsage` (`:377-384`) only fills fields the SDK's usage lacks — no double counting.
- **`toolResultOf` unguarded `JSON.parse` (`resume.ts:862`):** unreachable with non-JSON — every
  producer goes through `toolResultContent` (`toolResult.ts:90-94`), which always emits valid JSON,
  including the truncated case (a JSON *string* of head+tail).
