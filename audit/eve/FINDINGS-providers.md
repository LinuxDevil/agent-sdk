# Eve audit: providers, models & structured output

Tarball `1.0.0-alpha.19` (`ai@7.0.133`, `@ai-sdk/openai@4.0.89`, `zod@4.6.5`). Repros are in `audit/eve/providers/` (p1–p16, with logs `p2-output.log` and `p3-output.log`); run them with `npx tsx eve/providers/<file>` from `audit/`. About 50 live OpenRouter calls, costing under $0.05. `claude-3.5-haiku` and `gemini-2.0-flash` have left OpenRouter, so `claude-haiku-4.5` and `gemini-2.5-flash` were used instead.

## Summary
- **`output` fails on common schema shapes, and one failure is silent.** Discriminated unions, root unions, records and tuples get a 400 from strict OpenAI and Anthropic. On Claude, `z.record` silently validates as `{}`. `strict:true` is hard-coded and nothing falls back.
- **`maxCostUsd` and `costUsd` are silently off for most of OpenRouter's catalog.** OpenRouter's exact `usage.cost` is discarded, and cached-token prices are ignored.
- **There's no Anthropic prompt caching.** Calls cost 9.5× more than they need to.
- **Retries misbehave.** `Retry-After: 3600` sleeps an hour. `insufficient_quota` is retried. `timeoutMs` kills healthy streams. A `finish_reason: error` inside a 200 resolves as success.
- **Documented settings are dropped.** `stop` is never sent, `toolChoice` can't be set, and `reasoning` is skipped for several models.

## Findings

### PROV-F1: Strict structured output returns a 400 for discriminated unions, root unions, records and tuples, and nothing falls back
**Severity** high · **Lens** AI eng / SWE / Design · **Type** bug

**Evidence:** `p2-structured-matrix.ts`, `p3-union-optional.ts`, `p15-strict-keywords.ts`, live:
- **Discriminated union** (root or nested): gpt-4o-mini returns 400 `'oneOf' is not permitted`; claude-haiku-4.5 returns 400.
- **Root `z.union`**: 400 on both.
- **`z.record`**: gpt-4o-mini returns 400; Claude silently returns `{}` (see F2).
- **`z.tuple`**: 400.
- **Gemini and Llama** accept all of these.

The 400 surfaces as `LOUSHO_PROVIDER_REQUEST_FAILED`, not as `output-invalid`. Two docs contradict this: `docs/structured-output.md` presents root unions as supported, and `docs/decisions.md` says "Works on any provider".

**Root cause:**
- `structuredOutput.ts:111-135`: objects are closed, but `oneOf`, records and tuples are never rewritten.
- `structuredOutput.ts:259-271`: `typeRootUnion` emits `type:'object'` alongside `anyOf`.
- `aiSdkCompat.ts:259-268`: the schema is always sent with strict.

**Suggested fix:**
1. Rewrite `oneOf` to `anyOf` in the strict copy.
2. Wrap a root union as `{result: <union>}` and unwrap it after the call.
3. Convert records to `{key,value}[]` and tuples to objects, or fall back to JSON mode.
4. On a schema 400, retry once in JSON mode.
5. Add a strict-compatibility lint at `createAgent()` time.

### PROV-F2: On Claude, `z.record` output silently validates as an empty object (data loss)
**Severity** high · **Lens** AI eng · **Type** bug
- **Evidence:** `p2-structured-matrix.ts`: Claude returns `{counts:{}}` in 3 of 3 runs, with no repair.
- **Root cause:** same as F1.
- **Suggested fix:** F1 item 3. Until then, throw at `createAgent()` time when the output schema has a record and the model is strict.

### PROV-F3: `limits.maxCostUsd` and `costUsd` are silently off for most OpenRouter models
**Severity** high · **Lens** PM / SWE · **Type** bug
- **Evidence:** `p16-cost-budget-bypass.ts`: on claude-haiku-4.5 a $0.01 budget lets a run that OpenRouter priced at $8 finish, with `costUsd=null`. `p5-openrouter-raw-usage.ts` shows OpenRouter returns `cost` in every response. `p4-pricing.ts` shows lookup misses (the `.` vs `-` spelling) and wrong snapshot matches.
- **Root cause:**
  - `modelData.ts:126-142`: only 15 models are priced.
  - `registry.ts:61-72`: snapshot matching picks the wrong entries.
  - `runUsage.ts:63`, `llm.ts:256-262`, `OpenRouterProvider.ts:316-320`: OpenRouter's reported cost is dropped.
  - `budget.ts:18`: the budget check is skipped when cost is unknown.
- **Suggested fix:** have `OpenRouterProvider` fill `usage.costUsd` from `usage.cost`, and prefer a provider-reported cost over the estimate. Warn once when `maxCostUsd` is set and cost is unknown. Normalise `.`/`-` in model ids and tighten snapshot matching.

### PROV-F4: No Anthropic prompt caching; cached-token discounts are ignored in cost
**Severity** high · **Lens** AI eng / PM · **Type** enhancement / bug
- **Evidence:** `p12-prompt-caching.ts` vs `p12b-raw-cache-control.ts`: the second call costs $0.00784 through the SDK and $0.00066 when sent raw. On gpt-4o-mini, 5,632 cached tokens are priced at the full rate.
- **Root cause:** `llm.ts:194-242`, `aiSdkProvider.ts:364-386`, `registry.ts:100-107`.
- **Suggested fix:** add `createAgent({ promptCaching: 'auto' })` that puts `cache_control` on the system prompt and the last tool. Add cached-read and cache-write prices, and a `cacheWriteTokens` usage field.

### PROV-F5: `Retry-After` is not capped by `maxMs`; a 3600 s value makes the run sleep for an hour
**Severity** medium · **Lens** SWE / AI eng · **Type** bug
- **Evidence:** `p6-retry-classification.ts`.
- **Root cause:** `resilience.ts:74-82`, `errors.ts:335-347,554`.
- **Suggested fix:** clamp the wait to `maxMs`, and throw with `retryAfterMs` when the header asks for longer. Also read `retry-after-ms`, and honour `Retry-After` on 503.

### PROV-F6: OpenAI's `insufficient_quota` 429 is retried as a rate limit
**Severity** low · **Lens** SWE · **Type** bug
- **Root cause:** `errors.ts:379-381`.
- **Suggested fix:** add a non-retryable `quota-exceeded` category (also for 402).

### PROV-F7: `withRetry({ timeoutMs })` aborts a healthy stream partway through
**Severity** medium · **Lens** SWE · **Type** bug
- **Evidence:** `p7-stream-timeout.ts`.
- **Root cause:** `resilience.ts:102-107`.
- **Suggested fix:** clear the timer on the first chunk, and add an optional `idleTimeoutMs`.

### PROV-F8: An upstream failure inside a 200 response resolves as a normal run with truncated text
**Severity** medium · **Lens** AI eng / SWE · **Type** bug
- **Evidence:** `p13-finish-reasons.ts`: `finishReason:"error"`, text `"The capital of Fr"`, and the call resolves.
- **Root cause:** `aiSdkCompat.ts:121-131`.
- **Suggested fix:** throw a retryable provider error on a step `finishReason: 'error'`, and map unknown reasons to `'other'`.

### PROV-F9: `modelSettings.stop` is never sent; `toolChoice` can't be set
**Severity** medium · **Lens** AI eng / PM · **Type** bug
- **Evidence:** `p1-request-capture.ts`.
- **Root cause:** `aiSdkProvider.ts:364-386`, `aiSdkCompat.ts:271-290`.
- **Suggested fix:** pass `stopSequences` and `toolChoice` through, and add a contract test that each settings key appears on the wire.

### PROV-F10: `reasoning` is silently not sent to Fable, gpt-oss or DeepSeek V3.x
**Severity** medium · **Lens** AI eng / Design · **Type** bug / DX
- **Evidence:** `p10-reasoning.ts`.
- **Root cause:** `reasoning.ts:49-54,64`.
- **Suggested fix:** warn once when the setting isn't sent, add `fable` to the model regex, and use the OpenRouter catalog's `supported_parameters`.

### PROV-F11: `decide()` reports an abort as a timeout, doesn't check answers against questions, and never retries
**Severity** medium · **Lens** SWE / Design · **Type** bug / DX
- **Evidence:** `p8-decide.ts`.
- **Root cause:** `decide.ts:204,227-234,243-260`.
- **Suggested fix:** rethrow `AbortError` unchanged, validate each answer against its question, return a `byName` map, and retry.

### PROV-F12: `output` plus a `length` cutoff runs a futile repair call
**Severity** low · **Lens** AI eng · **Type** perf / DX
- Duplicate of CORE-F12; the fix is shared.

### PROV-F13: Registered providers can't be used in model strings; defaults point at retired models
**Severity** medium · **Lens** Design / PM · **Type** DX / bug
- **Evidence:** `p11-spec-resolution.ts`: `groq/...` returns `LOUSHO_PROVIDER_UNKNOWN` after `register('groq')`. The defaults are `claude-3-5-sonnet-latest`, `gpt-4` and `gpt-3.5-turbo`.
- **Root cause:** `providerSpec.ts:151,307-308`, `AnthropicProvider.ts:62`, `OpenRouterProvider.ts:558-571`.
- **Suggested fix:** fall through to the registry, and update the default models.

### PROV-F14: No client-side rate limiting or concurrency cap for model calls
**Severity** medium · **Lens** PM / SWE · **Type** enhancement
- **Suggested fix:** add `withRateLimit(provider, {requestsPerMinute, tokensPerMinute, maxConcurrent})` and `createAgent({ rateLimit })`.

### PROV-F15: Small accuracy issues
**Severity** low · **Lens** SWE / AI eng · **Type** bug / DX
- **Image tokens are underestimated by about 8×** (estimated 1,000, measured 8,524).
- **The context window falls back to 128k** for unknown OpenRouter models instead of reading the catalog's `context_length`.
- **`getModelInfo`/`getModels` use the global `fetch`** and don't cache.
- **An OpenRouter 402 is classified as `unknown`.**

## Verified non-issues
- Simple, nested, optional, enum, `.default`, integer-range and `z.lazy` schemas work on all four vendors.
- The optional-to-nullable rewrite holds on Gemini.
- Images reach the model correctly.
- OpenRouter upstream error details surface.
- Reasoning works on Claude 4.5.
- Basic retry classification is correct.
- Usage normalisation is correct.
- `result.object` types infer correctly.
- Config errors are coded.
