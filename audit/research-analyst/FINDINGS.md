# FINDINGS — research-analyst (deep-research pipeline, packed SDK @1.0.0-alpha.18)

Harness: `index.ts` + `corpus.ts`, run live against `openrouter/openai/gpt-4o-mini`
(two full runs, both all-PASS; see RUN_LOG.md). Surfaces exercised: `subagents`
fan-out via `task`, `output` schemas, `defineTool`, `usage`/`delegated`/`stepUsage`/
`costUsd`, `estimateCost`, `fileTraceExporter` + `listTraces`/`readTrace` + `withSpan`,
`llmJudge`, sessions + task resume, abort mid-run.

---

### F1: No way to parent an agent run under a caller-created span (`send()` drops `parentSpanId`)

- **Severity:** low-medium · **Type:** enhancement
- **Evidence:** `withSpan(exporter, 'research.wave.1', …)` around `coordinator.send()`
  produces a *separate root trace file* (1-line JSONL) — the run's `invoke_agent
  coordinator` span is not a child of my span, so LOU-D48 cost rollups can never
  aggregate a multi-`send()` pipeline into one trace. Confirmed: 8 trace files for
  5 agent runs + 3 phase spans, and `parentId` is absent on every `invoke_agent` root.
- **Root cause:** `ExecuteOptions.parentSpanId` exists (`src/execution/AgentExecutor.ts:206`)
  and is used internally to nest sub-agent spans (`src/execution/delegation.ts:228`),
  but `SendOptions` (`src/createAgent.ts:580-631`) has no field for it and
  `send()` does not forward one — so the option is unreachable from the public
  `SimpleAgent` API.
- **Suggested fix:** add `parentSpanId?: string` to `SendOptions` (and thread it
  through `callTurn`), or ship a `withTrace(exporter, name, fn)` helper that sets
  ambient span context for every `send` inside `fn`.

### F2: Trace files persist full prompt/tool payloads by default — `captureContent` is opt-in but legacy attrs are opt-out

- **Severity:** low (security-relevant default) · **Type:** DX / docs
- **Evidence:** `traces/<date>/*.jsonl` written by `fileTraceExporter` contain the
  coordinator's full system prompt (including my planted canary `ZEBRA-7717`), every
  `chat` span's full message array under the `prompt` attribute, and every
  `execute_tool` span's `args` + `result` verbatim — with `captureContent` unset
  (default off). Only `createAgent({ redactContent: true })` suppresses them.
- **Root cause:** `genAiSpanInit`/`recordToolOutcome` gate `gen_ai.*` content attrs
  on `captureContent` (default false, `src/execution/genAiSpans.ts:139-140,215-217,257-259`)
  but the DEPRECATED `input`/`prompt`/`args`/`result` attrs on `redactContent`
  (default false, `:138,161,253`). So the "privacy" switch and the "content" switch
  point in opposite directions by default, and the file exporter writes whatever it gets.
- **Suggested fix:** for file-backed exporters, default `redactContent: true` (or emit
  a one-line warning when `fileTraceExporter` is used without it); document the two
  knobs together in docs/observability.md — a consumer enabling tracing for the first
  time leaks full prompts to disk without ever opting in.

### F3: `execute_tool` span attribute `error` is a boolean, not the error message

- **Severity:** low (cosmetic) · **Type:** bug-ish / consistency
- **Evidence:** every successful `execute_tool knowledge_search` / `task` span in the
  JSONL carries `"error": false`. On `withSpan` spans the same `error` attribute
  (`LegacyAttr.ERROR`) holds the error *message string*
  (`src/execution/tracing.ts:46-53`). Same attribute name, two types depending on emitter.
- **Root cause:** `recordToolOutcome` writes `[LegacyAttr.ERROR]: !!outcome.error`
  (`src/execution/genAiSpans.ts:254`) — a coercion to boolean, so the message is lost
  from the attribute (it does land in `span.status.message` + `error.type`='tool_error').
- **Suggested fix:** emit the message (or omit the attr on success); if a boolean was
  intended, name it `hasError` — mixed-type attributes confuse OTel bridges.

### F4: A session turn's `result.messages` is the whole transcript, not the turn

- **Severity:** low · **Type:** docs / DX
- **Evidence:** in `repro/task-resume.ts`, `session.send()` turn 2's
  `ExecutionResult.messages` still contains turn 1's user/assistant/tool messages;
  filtering `toolName==='task'` counted both turns' calls (n=2, actually 1). Fix was
  `messages.slice(turn1.messages.length)`.
- **Root cause:** by design the executor returns the full message list it built on;
  `docs/sessions.md` documents `session.messages` as "a read-only snapshot of the
  transcript" but the `send()` return value's cumulative nature isn't stated anywhere
  on `ExecutionResult.messages` (`src/execution/AgentExecutor.ts:646`).
- **Suggested fix:** one line in the `messages` doc/field comment: "for session turns
  this includes all previous turns" — or expose `turnMessages`. Consumers diffing
  tool calls will otherwise over-count exactly as I did.

### F5: `ExecutionResult`'s `TObject` silently degrades when the generic is dropped

- **Severity:** info · **Type:** DX note
- **Evidence:** helper `timed(label, run: () => Promise<ExecutionResult>)` erased the
  schema type — `verifier.send()`'s `object` came back as `unknown`/`{}` at the
  callsite. SDK typing itself is correct under zod 4 (`result.object.a` compiled in a
  minimal repro; the packed d.ts's `StandardSchemaV1` constraint accepts zod 4
  schemas). Known zod-3-dts issue aside (already logged), the trap is purely that
  `ExecutionResult` without a type arg throws away `object`'s type.
- **Suggested fix:** none needed in SDK; worth a docs note that helpers wrapping
  `send()` must be generic over `TObject`.

---

## Model-quality observations (not SDK bugs)

- The gpt-4o-mini verifier re-flagged "OS/container OOM kills" and "diagnostics" as
  gaps in wave 2 *after* wave-2 researchers covered exactly those — the aggregate
  demonstrably contained all 6 briefs (verifier input tokens grew 1302→2474 between
  waves). The SDK correctly re-ran the loop and stopped at `maxWaves`. Verdict-schema
  plumbing (`output`, `object`) worked both times; the judge is just strict/dim.
- `knowledge_search` `maxConcurrent` stayed 1 in both runs although researcher
  `invoke_agent` spans overlapped (6 + 4 pairs): each researcher's tool call is sub-ms
  and lands at a different point in its run. Parallelism must be proven from spans,
  not tool-call overlap.
- `usage.delegated` accounting is exact: `runs` == `task` call count,
  `stepUsage.length + delegated.modelCalls === usage.modelCalls`, `byModel` sums equal
  the totals, and `sum(costUsd)` across all runs equals `estimateCost(totals, model)`
  to 1e-9 in both runs.

## What worked, verified live

- Same-turn parallel `task` fan-out (3 calls in one model turn, `toolConcurrency`
  unbounded): true concurrency proven by overlapping `invoke_agent researcher` spans.
- Clean-context isolation: child input is only the task prompt
  (`src/subagents/withSubagents.ts:226`); coordinator canary never leaked.
- Bounded verify→extend loop; `output` schema on both agents (zod 4) returned valid
  `object`s every call.
- Delegated usage roll-up, `formatUsage`, `estimateCost` parity (see above).
- `fileTraceExporter`: one JSONL per trace, nested sub-agent spans in the parent's
  file, `listTraces`/`readTrace` read-back works; `withSpan` emits standalone spans.
- `llmJudge` (`allowOutsideJudgeRunner`) scored the report; the outside-runner guard
  throws `LOUSHO_EVALS_INVALID` before any model call (repro/judge-guard.ts).
- Abort mid-fan-out resolves with `finishReason:'aborted'` and records killed children
  under `usage.delegated` (repro/abort-fanout.ts).
- `task` resume by `taskId` inside a session keeps the child's earlier transcript —
  the resumed researcher answered "which C# did you cite first" correctly
  (repro/task-resume.ts).
- `createAgent` fails fast with actionable `LOUSHO_CONFIG_INVALID` when a sub-agent
  lacks `description` (repro/subagent-no-description.ts).
