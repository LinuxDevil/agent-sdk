# invoice-extract: findings

This is an accounts-payable pipeline. It covers 15 text invoices plus one
real PDF, checked against hand-written ground truth. It runs as an SDK flow:
extract → validate → route, then writes `out/invoices.csv`.

It uses bounded concurrency, per-invoice `AbortSignal` timeouts, and
`withRetry`/`withFallback` (Responses API, then Chat Completions). Repro
scripts are in `repro/` and raw logs are in `out/`.

**Live accuracy:**
- Only a 6-document subset finished. 3 of the 6 timed out at about
  5 tokens/s on the shared server.
- 2 of 6 documents were fully correct: the German invoice and the rejected
  quote.
- 18 of 61 fields were correct.
- The PDF was hallucinated (see F9).
- This is not a fair measure of the model.

### F1: Tool steps in a flow bypass `needsApproval` and permission rules
- **Severity:** high
- **Type:** security
- **Evidence:** `repro/flow-semantics.ts` makes a $25,000 payment with no
  approval.
- **Root cause:** `src/flows/FlowExecutor.ts:775,794-830` calls
  `tool.execute` directly.
- **Fix:** route flow tool calls through the same permission and approval
  gate as the agent. If no approver is configured, fail closed.

### F2: Flow tool steps skip argument validation, and required flow inputs are not enforced
- **Severity:** high
- **Type:** bug
- **Evidence:**
  - A `z.number()` argument received `"[object Object]"`.
  - A `min(1)` string received `""`.
  - Repros: `repro/flow-semantics.ts` and `repro/flow-inputs.ts`.
- **Root cause:** `FlowExecutor.ts:775,803`. `validateFlowInput`
  (`src/flows/inputs.ts:202`) is never called.

### F3: Objects can't be passed between flow steps
- **Severity:** medium
- **Type:** DX
- **Evidence:**
  - `{{var}}` stringifies the object to `"[object Object]"`.
  - `"$var"` stays a literal string.
  - Dotted paths don't work.
- **Root cause:** `FlowExecutor.ts:880,915`.

### F4: Flows can't be cancelled
- **Severity:** medium
- **Type:** bug
- **Evidence:** the flow context has no `signal`, and a signal you pass is
  ignored. Flow tools get no abort signal either.
- **Root cause:** `FlowExecutor.ts:44-91,708,775`.

### F5: `withFallback` shares one "active provider" across concurrent calls
- **Severity:** high
- **Type:** bug
- **Evidence:**
  - The callback reports the wrong transition.
  - Usage for calls served by `gpt-4o` is booked under `gpt-4o-mini`, so
    cost is under-reported 16×: $0.00075 instead of $0.0125.
  - The result depends on timing.
  - Repro: `repro/fallback-concurrency.ts`.
- **Root cause:** `src/providers/resilience.ts:249,252,259,276-281` and
  `src/execution/generateStep.ts:94`.
- **Fix:** keep the per-call state local, and return the serving model on
  the response.

### F6: Repair fabricates data when the schema encodes a business rule
- **Severity:** high
- **Type:** docs / DX
- **Evidence:**
  - The schema checks `total = subtotal + tax`.
  - The invoice printed 120.00. After repair the model changed it to 119
    so the object would validate.
  - The run finished with `finishReason: 'stop'` and nothing marked the
    change.
- **Root cause:** `src/execution/structuredOutput.ts:148`.
- **Fix:**
  - Flag repaired output (`result.outputRepaired`).
  - Document that business rules belong after extraction.
  - Optionally offer `repair: 'structure-only'`.

### F7: A root-level union output schema is sent without `type: "object"`
- **Severity:** medium
- **Type:** bug
- **Evidence:** the model echoed the schema twice, then the run ended with
  `output-invalid`.
- **Root cause:** `structuredOutput.ts:97-115` and `src/utils/zodCompat.ts:67`.
- **Fix:** wrap the root union in an object, or reject it with a clear error.

### F8: `z.date()` is sent as `{}` and never validates, with no warning
- **Severity:** medium
- **Type:** DX
- **Root cause:** `zodCompat.ts:67` (`unrepresentable: 'any'`).
- **Fix:** warn or throw, and suggest `z.iso.date()` or `z.coerce.date()`.

### F9: PDF file parts fail on OpenAI-compatible servers and degrade silently under fallback
- **Severity:** high (in practice)
- **Type:** bug
- **Evidence:**
  - The Responses endpoint returns 400 and so does Chat Completions.
  - The fallback provider then replaces the PDF with a note saying it was
    not sent.
  - The model invents an invoice, which passes validation.
- **Root cause:** `src/providers/OpenAIProvider.ts:66`,
  `src/providers/aiSdkProvider.ts:126-138` and `resilience.ts:247`.
- **Fix:** an unsupported file part should throw (`LOUSHO_UNSUPPORTED_CONTENT`)
  instead of being replaced, at least when the user message's only content
  is that file.

### F10: The error reads only "Bad Request" when the error body is non-standard
- **Severity:** medium
- **Type:** DX
- **Evidence:** `repro/error-body.ts`.
- **Root cause:** `src/execution/errors.ts:443`.
- **Fix:** add a snippet of `responseBody` to the message.

### F11: "Context size has been exceeded" is classified inconsistently
- **Severity:** low
- **Type:** bug
- **Evidence:** on Responses it comes back as a 500 and is retried. On Chat
  Completions it is a 400 and is not retried. Neither is labeled a
  context-length error.
- **See also:** `_cross` X1.

### F12: The output schema is sent twice
- **Severity:** medium
- **Type:** perf
- **Evidence:**
  - It appears in the system prompt (4.2k of 5.2k characters) and in the
    response format, which adds about 1k tokens per call.
  - `z.iso.date()` adds a regex of about 280 characters per field.
- **Root cause:** `structuredOutput.ts:108`.
- **Fix:** add an `output.promptSchema: false` option, or omit the prompt copy
  when the provider enforces the response format.

### F13: Reasoning is never surfaced on OpenAI-compatible endpoints, and `force` does nothing
- **Severity:** low
- **Type:** docs
- **Note:** reasoning did not leak into `text` or `object`.

### F14: `approvals.resolve()` returns `object: unknown` on typed-output agents
- **Severity:** low
- **Type:** typing
- **Root cause:** `src/createAgentApprovals.ts:93`.

### F15: Flow results are untyped, the docs are thin, and step IDs collide
- **Severity:** low
- **Type:** docs / DX
- **Evidence:**
  - `output` is `unknown`.
  - The docs don't show the `{ name, prompt }` agent config, the tool
    registry, or that `execute()` never throws.
  - Steps without an ID all get `step-${Date.now()}` (`FlowExecutor.ts:388`).

### F16: No helper aggregates usage across runs, and `maxCostUsd` is inert for unpriced models
- **Severity:** low
- **Type:** enhancement

### F17: Non-streaming `send()` hits Node's ~300 s headers timeout on slow local generations
- **Severity:** medium
- **Type:** perf
- **Evidence:**
  - The error is "Cannot connect to API: Headers Timeout Error".
  - `withRetry` then restarts the whole generation, 10 times in one run.
  - The provider has no `fetch` or timeout option.
- **Fix:** expose `fetch` on the provider config, and treat a headers timeout
  as a timeout.

## What worked
- One shared agent handled 40 parallel `send()`s with no cross-talk.
- 12 concurrent approvals each got a unique ID and all resolved correctly.
- Per-run abort reliably ended runs as `aborted`.
