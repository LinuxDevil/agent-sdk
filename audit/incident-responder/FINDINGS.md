# FINDINGS — incident-responder audit

Harness: `audit/incident-responder/` (`index.ts`, `agents.ts`), run live against
`openrouter/openai/gpt-4o-mini` via `npx tsx incident-responder/index.ts`.
Evidence below is from real runs (see RUN_LOG.md); the packed dist in
`audit/node_modules/@lousho/build-ai-agent` was used throughout.

## What worked (verified live)

- **Webhook intake with real auth**: `webhookChannel({ auth: { type:'hmac', secret,
  timestampHeader, toleranceSeconds } })` + `mountChannels()` served
  `POST /channels/alerts`. Unsigned → 401, bad signature → 401, stale timestamp → 401,
  correctly signed alert → agent run. Timestamp-tolerant HMAC (`<ts>.<body>`) works
  exactly as `src/triggers/webhookAuth.ts:118-131` describes.
- **Parallel sub-agent fan-out**: one assistant turn carried 3 `task` tool calls; the
  three investigators' tool executions overlapped in wall-clock time (~97000–98140ms).
- **Sub-agent isolation**: all three investigators register a tool with the *same name*
  (`query_telemetry`) but different implementations; each sub-agent got only its own
  backend's data. Sub-agent task conversations are persisted as
  `subagent-task-<hash>.json` in the session store (LOU-Y6).
- **Typed decision**: `createAgent({ output: z.object({severity, confidence, rationale}) })`
  on the `severity-triage` sub-agent — its typed object reached the lead as JSON in the
  `task` result (LOU-V4.2).
- **Approval gate, fully durable**: `defineTool({ needsApproval: true })` paused the run
  with `finishReason:'awaiting-approval'` + `approvalId`; `approvals/<id>.json` and
  `checkpoints/inc-7001.turn-0.json` (`status:'awaiting-approval'`) were on disk;
  `agent.resume('inc-7001')` threw `SessionAwaitingApprovalError`;
  `agent.approvals.get(id)` returned the pending call (incl. parsed args).
- **Resume over HTTP**: `POST /channels/alerts/approvals/<id>` `{approved:true}` (itself
  HMAC-verified) continued the paused session turn; `restart_service` executed exactly
  once, only after approval; the approval file was claimed+deleted on resolve.
- **Handoff inside a resumed run**: `transfer_to_report_writer` was called after the
  approval-resume; the run continued as the specialist, which called
  `write_incident_report` and produced `incidents/INC-7001.md`.
- **Confidence floor**: ambiguous alert → no `restart_service` request at all,
  escalation text returned (`finishReason:'stop'`).

## Findings

### F1: `agent.approvals.get()` throws on a malformed id instead of returning `undefined`

- **Severity**: low · **Type**: bug / docs mismatch
- **Evidence**: `await commander.approvals.get('bogus id!')` throws
  `ConfigurationError` (`LOUSHO_CONFIG_INVALID`: "Invalid approval id ... it becomes a
  file name"). Also crashes with `undefined`/empty ids — real when the id comes from
  HTTP input.
- **Expected**: `docs/approvals.md:202-204` and the `AgentApprovals.get` doc comment
  (`src/createAgentApprovals.ts:77-78`) say it returns "`undefined` when `id` is unknown
  or already resolved". A malformed-but-unknown id is "unknown".
- **Root cause**: `get` delegates to `FileApprovalStore.load` → `fileFor` → `assertId`
  (`src/storage/fileStore.ts:60-66, 189-192, 207-211`), which throws on ids that fail
  `APPROVAL_ID_PATTERN` — before the "not found" path is reachable. `InMemoryApprovalStore`
  presumably returns `undefined` for the same id, so behaviour differs by store.
- **Suggested fix**: have `FileApprovalStore.load`/`resolve` treat a non-conforming id
  as "not found" (return `null`), or document the throw on `approvals.get`/`resolve`.

### F2: finished session turns delete their checkpoint *and* history — nothing left to fork

- **Severity**: low · **Type**: docs gap / design trade-off worth surfacing
- **Evidence**: after the completed `inc-7001` turn, `.lousho/checkpoints/` and
  `checkpoint-history/` are empty; `await commander.fork('inc-7001', { fromStep: 0 })`
  → `LOUSHO_CHECKPOINT_NOT_FOUND` ("steps kept: none"). By contrast, a `send(msg,
  { sessionId })` run keeps a `'finished'` checkpoint (`src/execution/AgentExecutor.ts:1705`)
  and stays forkable via `agent.fork(sessionId)`.
- **Root cause**: `AgentSession.commit()` calls
  `turn.checkpointStore.delete(turn.sessionId)` without `{ keepHistory: true }`
  (`src/session/AgentSession.ts:760-762`); `FileCheckpointStore.delete` then removes the
  history ring too (`src/storage/fileStore.ts:168-171`). `session.fork({ fromStep })`
  still works — it forks the saved *transcript*, not checkpoints
  (`src/session/AgentSession.ts:548-567`) — but the asymmetry (session turn history is
  ephemeral; run history is not) is nowhere spelled out.
- **Suggested fix**: document on `session()`/durable-execution.md that turn checkpoints
  (and their history) are dropped on commit, or keep history on commit
  (`delete(id, { keepHistory: true })`).

### F3: webhook pause response drops the human-readable approval prompt

- **Severity**: low · **Type**: DX
- **Evidence**: on the approval pause, the webhook caller receives the raw
  `ExecutionResult`: `{ finishReason:'awaiting-approval', approvalId:'…', text:'' }` —
  `text` is empty because the model's last turn was a bare `restart_service` tool call.
  Yet `channelCore` *did* compute a friendly prompt ("Approve restart_service
  {"service":"checkout",…}? (approval id: …)") via `approvalPrompt()` and passed it as
  `ctx.text` (`src/channels/channelCore.ts:184`, `src/channels/defineChannel.ts:211-219`).
- **Root cause**: `webhookChannel.reply` does `respond?.(200, result ?? { text })`
  (`src/channels/webhookChannel.ts:86-88`) — when `result` exists the prompt `text` is
  discarded. A PagerDuty-style consumer must know to read `approvalId` and construct
  its own prompt.
- **Suggested fix**: when `result.finishReason === 'awaiting-approval'`, merge the
  prompt into the body, e.g. `respond(200, { ...result, approvalPrompt: ctx.text })`.

### F4: `decide()` is hard-bound to OpenAI's Decisions API — verified unreachable via OpenRouter

- **Severity**: info · **Type**: documented limitation, verified live + enhancement suggestion
- **Evidence**: `decide({ baseURL: 'https://openrouter.ai/api/v1', apiKey: <OPENROUTER_API_KEY>,
  questions: […] })` → `SDKError LOUSHO_PROVIDER_REQUEST_FAILED`:
  "POST https://openrouter.ai/api/v1/decisions returned 404".
- **Root cause**: by design — `src/decisions/decide.ts:184-188` states the endpoint "is not
  part of the chat-completions surface, so it does not go through providers or OpenRouter",
  and only `gpt-6-luna` is served. There is no fallback: non-OpenAI users simply cannot
  use `decide()`.
- **Suggested fix**: add a provider-agnostic fallback (a one-call `output`-schema run
  through the normal provider pipeline) or expose the predicate/choice/score question
  shapes on top of `createAgent({ output })`, so the typed-decision pattern works on any
  provider. Until then, a clear `LOUSHO_DECISIONS_UNSUPPORTED_PROVIDER` error would beat
  a generic 404.

### F5: `webhookChannel()` has no first-class session-id mapping

- **Severity**: low · **Type**: enhancement
- **Evidence**: to get a predictable, filename-safe session id (needed to call
  `agent.resume('inc-7001')` and to find `.lousho/sessions/inc-7001.json`), I had to
  monkey-patch the returned object after construction:
  `alerts.sessionId = (inbound) => String(inbound.sessionKey)`. This works only because
  `defineChannel` returns the object un-frozen (`src/channels/defineChannel.ts:195-200`)
  and `webhookChannel` never sets the field (`src/channels/webhookChannel.ts:78-91`).
  The default mapping `` `${name}:${sessionKey}` `` contains a colon, which fails the
  session-id regex and gets hashed (`defineChannel.ts:205-208`), making the resulting
  session id unguessable — painful for incident-keyed workflows.
- **Suggested fix**: accept `sessionId?: (inbound) => string` (or a `sessionPrefix`)
  in `WebhookChannelOptions`.

### F6: inconsistent tool-call shapes across result vs events

- **Severity**: low · **Type**: DX
- **Evidence**: `ExecutionResult.toolCalls` uses the OpenAI wire shape
  `{ id, type:'function', function:{ name, arguments } }` (`src/providers/llm.ts:116-124`),
  while stream events use `{ toolName, args }` (`src/execution/agentEvents.ts:117-119`).
  Harness code mapping `toolCalls` with `c.toolName ?? c.name` silently produced
  `[null,null,null,null]`; the right access is `c.function.name`.
- **Suggested fix**: document `ExecutionResult.toolCalls`' shape in
  api-overview/streaming docs (no mention today), or normalize to
  `{ toolName, args }` plus a `raw` field.

## Notes (not SDK bugs)

- gpt-4o-mini sometimes picks `background: true` on `task` calls and then polls
  `agent_status` repeatedly (8 polls observed in one run). The `AWAIT_APPROVAL_HINT`/
  tool descriptions could push harder toward "await once", but this is primarily
  small-model behaviour.
- `tsx` runs `.ts` import specifiers fine but `tsc --noEmit -p audit/tsconfig.json`
  reports TS5097 for them — needs `allowImportingTsExtensions` (audit-project config,
  not SDK).
