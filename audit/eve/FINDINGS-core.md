# Eve audit: core

Scope: `createAgent`, `send()`/`stream()`, events, `ExecutionResult`, `modelSettings`, `maxSteps` and the forced answer, abort and timeouts, errors, dynamic config, TS types, and the UI bindings (`src/ui`, react/vue/svelte). Tarball `1.0.0-alpha.19`. Repros: `audit/eve/core/` (`npx tsx eve/core/<file>` from `audit/`; the type probe is `npx tsc --noEmit -p eve/core/tsconfig.json`).

## Summary
- **The browser chat forgets everything.** UI remote mode never sends a `sessionId`, so every turn opens a new session (F1).
- **A throwing `onEvent` listener rejects `send()` after side effects ran.** A caller that retries charges the card twice (F2).
- **Synthetic prompts are persisted as `user` messages** (F3). Round-tripping `result.messages` duplicates the system prompt (F4).
- **`limits.maxSteps` bypasses the D3 forced answer.** `maxSteps: 0/-1/NaN` is accepted (F5).
- **The error taxonomy is fiction.** `RateLimitError` and `TimeoutError` are never thrown (F6).
- **Typed output is lost after an approval** (F8). The chat reducer glues step texts together and hides non-stop endings (F9).

## Findings

### CORE-F1: UI remote mode is single-turn; every browser message starts a new session
**Severity** high · **Lens** PM / SWE / Design · **Type** bug
**Evidence** — `r1-ui-remote-multiturn.ts`: the POST bodies are `{"input":...}` only, the model sees 1 user message per turn, and turn 2 has amnesia.
**Root cause** — `src/ui/agentRunner.ts:22-26,125`; `src/server/routeHandler.ts:120` (`sessionId ?? newId()`).
**Suggested fix** — Generate a `chatId` in `createAgentRunner`, send `{input, sessionId}`, regenerate it on `reset()`, and allow `{url, sessionId}`.

### CORE-F2: A throwing `onEvent` listener fails the run after side effects ran
**Severity** high · **Lens** SWE · **Type** bug
**Evidence** — `r12-onevent-throw.ts`: a throw on `tool.done` or `run.done` rejects `send()` with `emailsSent=1`.
**Root cause** — `src/execution/agentRun.ts:302` (no try/catch around listeners).
**Suggested fix** — Isolate each listener and report the error once.

### CORE-F3: Synthetic "out of steps" and "[output-invalid]" prompts are stored as user messages
**Severity** medium · **Lens** AI eng / SWE · **Type** bug
**Evidence** — `r2-maxsteps-forced.ts` B/C/E: both prompts appear in `result.messages` and in session transcripts.
**Root cause** — `src/execution/AgentExecutor.ts:969-972`; `structuredOutput.ts:519-532`.
**Suggested fix** — Keep them request-only, or tag them and strip them before commit and from `result.messages`.

### CORE-F4: Feeding `result.messages` back into `send()` duplicates the system prompt
**Severity** medium · **Lens** AI eng · **Type** bug
**Evidence** — `r11-messages-roundtrip.ts`: turn 2 has 2 system messages.
**Root cause** — `src/execution/agentRunState.ts:100-102`.
**Suggested fix** — Skip the prepend when the input already starts with the same system message.

### CORE-F5: `limits.maxSteps` bypasses the forced answer; `maxSteps` is not validated
**Severity** medium · **Lens** AI eng / Design · **Type** bug
**Evidence** — `r19-two-maxsteps.ts`: `limits.maxSteps:1` gives `budget-exceeded` with `object=undefined`. `r2` D: `maxSteps` of 0, -1 or NaN is accepted and makes 0 calls; 1.5 behaves as 2.
**Root cause** — `src/execution/budget.ts:150-153`, `AgentExecutor.ts:938,1025`.
**Suggested fix** — Route `limits.maxSteps` exhaustion through `outOfSteps()`, and add `assertMaxSteps` (an integer >= 1).

### CORE-F6: `RateLimitError` and `TimeoutError` are never thrown; one code covers all provider failures
**Severity** medium · **Lens** SWE / Design · **Type** bug / docs
**Evidence** — `r8-error-classes.ts`: 429, timeout, 401 and context overflow all give `LOUSHO_PROVIDER_REQUEST_FAILED`. `docs/errors.md:210-217,917` describes a different behavior and cites a removed `retryWithTimeout()`.
**Root cause** — `src/execution/errors.ts:134-156,675-680`.
**Suggested fix** — Give each category its own code, or throw the documented subclasses, and fix the docs.

### CORE-F7: A sub-agent's dynamic config never sees the caller's metadata, principal or sessionId
**Severity** medium · **Lens** SWE / PM · **Type** bug
**Evidence** — `r10-dynamic-config.ts`.
**Root cause** — `src/createAgent.ts:1049` (`specs.resolve({ input: prompt })`).
**Suggested fix** — Pass the parent's `RunConfigContext` through.

### CORE-F8: Typed `output` is lost on `approvals.resolve()` and `streamResolve()`
**Severity** medium · **Lens** SWE / Design · **Type** DX
**Evidence** — `r5-types.ts` gives TS2339 at lines 25 and 29.
**Root cause** — `src/createAgentApprovals.ts:93,104,118,120`.
**Suggested fix** — Make `AgentApprovals<TObject>` generic, and add a `.test-d.ts`.

### CORE-F9: The chat reducer glues step texts together and hides non-`stop` endings
**Severity** medium · **Lens** Design / PM · **Type** bug / DX
**Evidence** — `r9-ui-reducer.ts`: the bubble reads "weather.It is". For max-steps, output-invalid and budget-exceeded endings, status is idle with no error.
**Root cause** — `src/ui/reducer.ts:111-114,227-228`.
**Suggested fix** — Add ordered parts or a separator per step, add `finishReason` and `object` to the state, and map non-stop endings.

### CORE-F10: `for await (agent.stream())` ends normally when the run fails
**Severity** medium · **Lens** SWE / Design · **Type** DX
**Evidence** — `r4-stream-abort-errors.ts` A.
**Root cause** — `src/execution/agentRun.ts` (`drain()` and a swallowed `result.catch`).
**Suggested fix** — Rethrow from the iterator after an error `run.done` (opt-out), and document it.

### CORE-F11: Stop during a model reply erases the user's message from the session; aborted calls count 0 tokens
**Severity** medium · **Lens** PM / Design · **Type** enhancement
**Evidence** — `r16-live-session-stop.ts` (live), `r18-session-abort-midmodel.ts`.
**Root cause** — `src/session/AgentSession.ts:385-388,803-809`.
**Suggested fix** — Commit the user input plus the partial reply (marked interrupted), and count streamed usage.

### CORE-F12: A truncated (`length`) structured reply gets a futile repair attempt and is reported as `output-invalid`
**Severity** medium · **Lens** AI eng · **Type** bug
**Evidence** — `r6-malformed-calls.ts` B.
**Root cause** — `checkOutput` ignores the step's `finishReason`; `structuredOutput.ts:519-532`.
**Suggested fix** — Skip the repair after `length`, and report `outputError.kind='truncated'` with a hint to raise `maxTokens`.

### CORE-F13: `modelSettings` not validated; no `toolChoice` or per-call `maxSteps`; no partial-object streaming
**Severity** medium · **Lens** PM / Design · **Type** enhancement
**Evidence** — `r7-live-usage-settings.ts`: `maxTokens:-1` and `temperature:5` cost a round trip and report AI SDK parameter names. In `r5-types.ts`, `toolChoice` is a type error.
**Root cause** — `src/providers/llm.ts:216` (`toolChoice` is never forwarded); `AgentExecutor.ts:974`.
**Suggested fix** — Validate ranges with `LOUSHO_CONFIG_INVALID`, forward `toolChoice`, add per-call `maxSteps`, and add an `object.delta` event.

### CORE-F14: `finishReason` is an open `string` union, so typos compile
**Severity** low · **Lens** SWE / Design · **Type** DX
**Root cause** — `src/execution/AgentExecutor.ts:144-152`.
**Suggested fix** — Close the union and map unknown reasons to `'other'`.

### CORE-F15: Abort/timeout edges: a provider that ignores the signal makes abort a no-op; no default call timeout
**Severity** low · **Lens** SWE / AI eng · **Type** bug
**Evidence** — `r4-stream-abort-errors.ts` C: abort at 100 ms resolves after 3 s with `finishReason=stop`.
**Suggested fix** — Re-check the signal after `generate()` and after each tool batch, make `mockModel` honour `signal`, add an `abortReason`, and add a default per-attempt and stream-idle timeout.

### CORE-F16: A missing API key throws inside `createAgent()` (at import time)
**Severity** low · **Lens** Design · **Type** DX
**Evidence** — `r13-model-spec.ts`.
**Suggested fix** — Defer the key lookup to the first run.

### CORE-F17: Small UI and DX inconsistencies
**Severity** low · **Lens** Design · **Type** DX
- React has no `reset()` (`src/react/useLoushoAgent.ts:49`).
- Remote errors lose the server message (`src/ui/agentRunner.ts:72`).
- `formatUsage` shows real costs as `$0.0000` (`src/models/usage.ts:133-135`).
- Usage has duplicate keys.
- `steps` does not count the forced call.
- Duplicate tool-call ids get mis-paired results (`r6` E).
- Without `output`, `max-steps` returns stale narration.

## Verified non-issues
- The D3 forced answer works live on gpt-4o-mini and claude-haiku-4.5.
- Abort against a real provider is prompt.
- Usage and cost are accurate.
- Malformed tool arguments are handled.
- Model-spec errors are coded.
- B4 holds.
- Typed output holds on `send()`, session, `stream()` and `resume()`.
