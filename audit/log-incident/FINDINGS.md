# log-incident: findings

The SRE incident-triage harness. Scripts referenced below are in `repro/` and
`scenarios/`, and raw output is in the gitignored `.lousho/*.log`.

Most findings were verified deterministically with `mockModel`, real child
processes, real SQLite and file stores, and the fault-injecting `proxy.ts`. The
shared LM Studio server was saturated by the other audit agents during this
run, which matters most for F1.

## F1: Errors that arrive mid-stream are never retried
- **Severity:** high
- **Type:** bug
- **Evidence:**
  - `scenarios/resilience.ts sseerr-stream` returns HTTP 200, sends some events, then sends an error event. LM Studio really does this on context overflow (`.lousho/run-main-1.log`).
  - `withRetry` only retries when the error is the first chunk.
  - Attaching an `onEvent` listener silently switches `send()` to streaming model calls, which disables retry for these failures.
- **Root cause:** `src/providers/resilience.ts:136-150` only treats a first-chunk failure as retryable. `src/execution/AgentExecutor.ts:243-265` picks streaming whenever there is a listener.
- **Suggested fix:**
  - Retry a stream that fails before any text or tool-call delta has been emitted.
  - Expose `streamModelCalls` on `createAgent`, so that observing events doesn't change failure semantics.

## F2: LM Studio context-overflow errors are classified `unknown`, inconsistently
- **Severity:** medium
- **Type:** bug
- **Evidence:**
  - Neither LM Studio message matches the overflow pattern: "exceeds the available context size" (HTTP 500 on `generate`) or "Context size has been exceeded" (an SSE error event on `stream`).
  - The same failure comes back `retryable: true` through `generate()` and `retryable: false` through `stream()`.
- **Root cause:** `src/execution/errors.ts:322`, `:440`. This is the same issue as `_cross` X1.
- **Suggested fix:**
  - Extend the pattern to cover both messages.
  - Classify streamed errors with the same function as `generate()` errors.

## F3: Compaction assumes a 128K window for unknown models
- **Severity:** medium
- **Type:** DX
- **Evidence:** `compaction: true` does nothing on the 8K local model, and nothing warns about it.
- **Root cause:** `src/context/compaction.ts:80`, `:286`. This is the same issue as `_cross` X2.
- **Suggested fix:** see X2.

## F4: The compaction token estimate leaves out tool definitions
- **Severity:** medium
- **Type:** bug
- **Evidence:** `repro/token-estimate.ts` estimated 585 tokens, but LM Studio billed 1,448 input tokens for the same request.
- **Root cause:** `src/context/compaction.ts:353` counts only messages.
- **Suggested fix:** include the serialized tool schemas and the system prompt in the estimate. Optionally, calibrate against the last real `usage.inputTokens`.

## F5: One rejected summary disables summarizing for the rest of the run
- **Severity:** medium
- **Type:** bug
- **Evidence:** `repro/compaction-mock.ts` case B. At step 2 the only foldable content is the user message. The summary comes out longer, gets rejected, and is never attempted again, even after the history grows.
- **Root cause:** `src/context/compaction.ts:255-262`, `:365-377` latch the strategy for the whole run.
- **Suggested fix:** retry summarizing on a later step once more foldable content has been added since the rejection.

## F6: The summarizer's model call is not counted
- **Severity:** medium
- **Type:** bug
- **Evidence:** `repro/summary-usage.ts`. The summary call is missing from `result.usage`, has no trace span, and bypasses token and cost budgets.
- **Root cause:** `src/context/compaction.ts:224-232` calls the summarizer outside the usage, tracing and budget pipeline.
- **Suggested fix:**
  - Route the summary call through the same accounting as normal steps.
  - Record it under `usage.byModel` and emit a `chat` span tagged `compaction`.

## F7: Nothing caps a fresh tool-result batch
- **Severity:** medium
- **Type:** enhancement
- **Evidence:** `repro/compaction-mock.ts` case D. The latest turn's tool results are never pruned, so one large grep result overflows the window.
- **Root cause:** `src/context/compaction.ts:103-113` protects the newest turn unconditionally.
- **Suggested fix:**
  - Add a per-tool-result token cap (`maxToolResultTokens`) that truncates with a marker.
  - Alternatively, spill oversized results to an artifact and give the model a handle to it.

## F8: Near-miss JSON costs a full repair call
- **Severity:** medium
- **Type:** perf
- **Evidence:** `scenarios/output-repair.ts offline`. Each of these triggers another full model call:
  - a prose prefix before the JSON
  - trailing prose after a fenced block
  - a `<think>…</think>` block before the JSON
- **Root cause:** `src/execution/structuredOutput.ts:126-145` only strips a whole-message code fence.
- **Suggested fix:**
  - Before falling back to repair, strip `<think>` blocks.
  - Extract the first balanced JSON object or array (or a fenced block) from the text, then validate it.

## F9: Finished parallel tool calls run again after a crash
- **Severity:** medium
- **Type:** bug
- **Evidence:**
  - `repro/durable-mock.ts` case B.
  - A live run of `durable.ts`: `call_…153` finished, the process was killed, and the call ran again on `resume()`.
- **Root cause:** `src/execution/toolBatch.ts:189-200` checkpoints results only as an in-order prefix. A call that completes behind a slower earlier call is lost.
- **Suggested fix:** checkpoint each tool result keyed by `toolCallId` as soon as it settles, and replay any that already exist on resume.

## F10: `abort()` waits for tools that ignore the signal
- **Severity:** medium
- **Type:** DX
- **Evidence:** `scenarios/cancel.ts`. `send()` settled 14.1 s after `abort()`.
- **Root cause:** `src/execution/toolBatch.ts:130-138` awaits every in-flight tool.
- **Suggested fix:**
  - Race the in-flight tools against the abort, with a grace period (`abortGraceMs`).
  - Settle the run as `aborted` and mark the abandoned tools as `cancelled`.

## F11: Retries stack and multiply HTTP calls
- **Severity:** low
- **Type:** DX
- **Evidence:** `createAgent({ provider, retry })` combined with the ai SDK's built-in `maxRetries: 2` produced 9 HTTP calls instead of 3.
- **Root cause:** `src/createAgent.ts:1349` wraps the provider without disabling the inner retries.
- **Suggested fix:** pass `maxRetries: 0` to the ai SDK whenever the SDK's own retry is active.

## F12: The server-down error hides `ECONNREFUSED`
- **Severity:** low
- **Type:** DX
- **Evidence:** the error message is only "Cannot connect to API: ", with `category: unknown`.
- **Root cause:** `src/execution/errors.ts:364-395`, `:440` don't walk the cause chain.
- **Suggested fix:**
  - Walk `cause`, add `ECONNREFUSED`/`ENOTFOUND` to the message, and categorize it as `connection`.
  - Add a hint such as "is your local server running at <baseURL>?".

## F13: `compaction.done.strategy` disagrees with `compaction.start.strategy`
- **Severity:** low
- **Type:** bug
- **Evidence:** after a rejected summary, the start event says two-phase and the done event says prune.
- **Root cause:** `src/context/compaction.ts:359` vs `:384`.
- **Suggested fix:** report both the requested and the applied strategy.

## F14: The object form of `compaction` cannot take `onCompaction`
- **Severity:** low
- **Type:** DX
- **Evidence:** there is no way to read the summary text.
- **Root cause:** `src/context/agentCompaction.ts:12` picks only a subset of the hook options.
- **Suggested fix:** pass `onCompaction` through, and include the summary in the `compaction.done` event.

## F15: Retries are invisible in traces
- **Severity:** low
- **Type:** enhancement
- **Evidence:** a `chat` span lasting 2m04s hides 4 failed attempts.
- **Suggested fix:** emit a span event or child span per attempt, with the status and error category.

## F16: No per-agent `maxTokens` or `temperature`
- **Severity:** low
- **Type:** DX
- **Evidence:** injecting `maxTokens` through a provider wrapper is silently overridden.
- **Root cause:** `src/execution/generateStep.ts:118-123` always passes `maxTokens: undefined` explicitly.
- **Suggested fix:**
  - Add `modelSettings` to `createAgent`.
  - Omit undefined keys instead of setting them.

## F17: Aborted results lose `signal.reason`
- **Severity:** low
- **Type:** DX
- **Evidence:** a cancelled tool is recorded as `kind: 'execution'`.
- **Suggested fix:** keep `abortReason` on the result and add an error kind of `cancelled`.

## F18: `Partial<CreateAgentConfig>` cannot be spread back into `createAgent()`
- **Severity:** low
- **Type:** DX
- **Evidence:** spreading it fails with TS2322, because the config type is a union.
- **Root cause:** `src/createAgent.ts:575`.
- **Suggested fix:** export a non-union `CreateAgentOptions` base type for composition.

## F19: LM Studio ignores `json_schema` on `/v1/responses`
- **Severity:** low
- **Type:** docs
- **Evidence:** structured output relied on the prompt alone, and the schema was not enforced server-side.
- **Root cause:** the same Responses-API default as `_cross` X3.
- **Suggested fix:**
  - Document this.
  - Use `/chat/completions` with `response_format` for compatible servers.

## What worked well

- Parallel tool calls run concurrently and are recorded in call order.
- `resume()` does not regenerate a checkpointed model turn.
- An abort during generation cancels the HTTP request within 2–4 ms and returns `finishReason: 'aborted'`.
- `retry.timeoutMs` bounds a hung server.
- The `[output-invalid]` repair prompt is precise.
- `lousho traces` shows `-` for unpriced cost rather than a misleading 0.

## Live run at 32k (`.lousho/run-main-32k.log`)

This run used the model reloaded at 32k with 4 slots, with the harness's
`contextWindow` set to 8192.

- **Outcome:** `finishReason: max-steps` after 14 steps, in 1,490 s.
  - Usage was 107,647 input and 2,413 output tokens; 45,679 of the input
    tokens were cached.
  - No incident report was produced.
- **Compaction worked:**
  - It fired from step 3 onward, pruning 2 to 6 tool results per step.
  - The summarizer ran once (`summary: true`), taking 6,345 tokens down to
    3,585.

### F20: Pruning tool results makes a small model re-issue the same calls
- **Severity:** medium
- **Type:** enhancement
- **Evidence:** compaction pruned `logs_around(14:05:00, app)` and
  `search_logs("\" 5[0-9]", nginx)`. The model then requested exactly the same
  calls again at steps 8, 9 and 13. Pruned results leave no trace the model can
  use, so it fetches them again until it hits `maxSteps`.
- **Suggested fix:**
  - Replace a pruned result with a short stub, for example
    `[pruned: logs_around(...) returned 1031 chars; first lines: …]`.
  - And/or offer an opt-in per-run memo, so an identical call returns the
    cached result with a note saying so.

### F21: `maxSteps` with `output` ends with no answer instead of forcing one
- **Severity:** medium
- **Type:** enhancement
- **Evidence:** the run stopped at `max-steps` after 110k tokens of
  investigation. It returned `object: undefined` and empty text, and made no
  final attempt to produce the structured report from what it had gathered.
- **Suggested fix:**
  - On the last step, when `output` is set, call the model once more with
    `toolChoice: 'none'` and an instruction to answer now.
  - Expose this as `finalStep: 'force-answer'`.

### F22: `result.toolCalls` uses the wire shape, unlike events
- **Severity:** low
- **Type:** DX
- **Evidence:** in `result.toolCalls`, items look like
  `{ id, type, function: { name, arguments: '<json string>' } }`. Events and
  trajectories instead use `toolName` with parsed `args`. A harness that read
  `c.toolName ?? c.name` printed empty names.
- **Root cause:** `src/execution/AgentExecutor.ts:647` exposes
  `ToolCall` (`src/providers/llm.ts:116`) directly.
- **Suggested fix:** add normalized `{ toolCallId, toolName, args }` records,
  for example `result.calls`, and keep the wire shape for compatibility.
