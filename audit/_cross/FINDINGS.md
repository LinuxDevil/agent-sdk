# Cross-cutting findings (packaging, providers, local models)

Found while wiring the packed `@lousho/build-ai-agent@1.0.0-alpha.18` tarball
(`ai@7.0.133`, `@ai-sdk/openai@4.0.89`, `zod@4.6.5`) to LM Studio. Repros live in
`audit/_cross/repro/`.

### X1: Context overflow from llama.cpp / LM Studio is classified `unknown` + `retryable`

**Severity:** high · **Type:** bug

**Evidence** (`repro/overflow2.ts`): a 20k-token prompt against a model loaded with
an 8,192-token context. LM Studio answers HTTP 500 with body
`"request (20018 tokens) exceeds the available context size (8192 tokens)"`,
`"type":"exceed_context_size_error"`. The thrown `CompactedLLMProviderError` has
`compacted.category: "unknown"`, `retryable: true`, and its `cause` is an `AI_RetryError`
with `maxRetriesExceeded`. The ai SDK retried the request 3 times even though it can never succeed.

**Root cause:** `src/execution/errors.ts:322-323`: `CONTEXT_LENGTH_PATTERN` does not
match "context size" or `exceed_context_size`. The 400 branch at `errors.ts:384`
also never runs because llama.cpp wraps it in a 500. The code then falls back to
`err.isRetryable` (`errors.ts:395`), which is true for a 5xx.

**Impact:** `withRetry()` and the ai SDK retry a deterministic failure. The opt-in
model-actionable path for `context-length-exceeded`
(`isModelActionableProviderErrorCategory`, `errors.ts:543`) never runs for the most
common local runtimes: llama.cpp, LM Studio, and Jan.

**Suggested fix:** extend the pattern with `context size|exceed_context_size|n_ctx`.
Check the context pattern before the status-code fallbacks for every status, not only
400. Add a fixture test using the exact llama.cpp body above.

### X2: Unknown models silently assume a 128k context window

**Severity:** high · **Type:** bug / DX

**Evidence:** `getModelInfo('qwen3.5-9b-…')` returns `undefined`
(`repro/chat-completions.ts`). LM Studio reports `loaded_context_length: 8192`
(`GET /api/v0/models/<id>`). Compaction and tool search use
`FALLBACK_CONTEXT_WINDOW = 128_000` (`src/context/compaction.ts:80,287`,
`src/execution/toolSearch.ts:45,193`). That is 15× the real window, so with
`thresholdPercent: 0.8` compaction would wait for about 102k tokens. The server fails
at 8k (see X1). Nothing warns the user.

**Suggested fix:**
1. Emit a one-time warning event when the fallback window is used.
2. Accept `contextWindow` on the provider config, or document `registerModel()` for
   local models in `docs/compaction.md` and `docs/providers.md`.
3. Optionally probe local runtimes: LM Studio `/api/v0/models/<id>`
   (`loaded_context_length`) and Ollama `/api/show` (`num_ctx`).

### X3: `OpenAIProvider({ baseURL })` always calls the Responses API

**Severity:** medium · **Type:** DX / enhancement

**Evidence** (`repro/endpoint-probe.ts`, which logs paths through a proxy): every
call goes to `POST /v1/responses`. LM Studio implements that endpoint. Many
"OpenAI-compatible" servers do not: llama.cpp `server`, Groq, DeepSeek, Together,
Fireworks, and older vLLM/Ollama `/v1` builds only implement `/v1/chat/completions`.
`OpenAIProvider` has no option to choose. `OpenRouterProvider` already uses `.chat()`
(`src/providers/OpenRouterProvider.ts:356-360`).

**Workaround (verified):** `fromAiSdk(createOpenAI({ baseURL }).chat(id))` works with
tools (`repro/chat-completions.ts`).

**Suggested fix:** add `api?: 'responses' | 'chat'` to `OpenAIProviderConfig`, and
default it to `'chat'` when `baseURL` is not api.openai.com.

### X4: No first-class local or OpenAI-compatible provider spec, and it is undocumented

**Severity:** medium · **Type:** docs / enhancement

**Evidence:**
- `grep -r "OPENAI_BASE_URL\|LM Studio\|vLLM\|llama.cpp" docs README.md` finds nothing.
  `model: 'openai/<id>'` + `OPENAI_BASE_URL` works only because `@ai-sdk/openai`
  reads that variable.
- A local server needs a dummy `OPENAI_API_KEY`, because the spec requires it
  (`src/providers/providerSpec.ts`, `envRequired: true`).
- `lousho doctor` reports "openai (OPENAI_API_KEY): set" but never shows the base URL
  and never checks that the endpoint answers.

**Suggested fix:**
- Add an `openai-compatible/<model>` spec, or `lmstudio/<model>`, reading
  `OPENAI_COMPATIBLE_BASE_URL`, with an optional key.
- Add a "Local models" section to `docs/providers.md`.
- Add `lousho doctor --ping`, which calls `/models` on the configured base URL.

### X5: Shipped `.d.ts` files are built against zod 3 and fail type-checking under zod 4

**Severity:** medium · **Type:** bug (packaging / typings)

**Evidence:** `npx tsc -p tsconfig.strictlib.json` (`skipLibCheck: false`) with
`zod@4.6.5`, which the README recommends with `ai@7`, reports 26 errors in
`dist/createAgent-*.d.ts`, `dist/registry-*.d.ts` and `dist/tools/index.d.ts`. The
errors include `ZodEffects` missing, `ZodObject` given 5 type arguments, and
`ZodEnum<[...]>` tuple constraints. The repo builds its declarations with
`zod@3.25.76` (root `node_modules`), so the emitted types inline zod-3-only generics.
The scaffolder sets `skipLibCheck: true` (`packages/create-lousho-agent/tsconfig.json:14`),
which hides the problem for new projects but not for existing ones.

**Suggested fix:** do not emit inferred zod types in public declarations. Annotate the
exported schemas as `z.ZodType<T>`, or export the TS types plus a schema typed
`ZodTypeAny`. Add a `tsc --noEmit` pack-smoke step with zod 4 and
`skipLibCheck: false` to `scripts/pack-smoke.ts`.

### X6: `cost` is `undefined` for local models, with no hint why

**Severity:** low · **Type:** DX

**Evidence:** every local run returns `cost: undefined`. This matches the documented
behavior ("undefined if unpriced"). However, a local model costs $0, and a team
tracking spend cannot tell "free" apart from "unknown".

**Suggested fix:** let providers declare `pricing: 'free'`, or set pricing on the
provider config (`{ inputPerMTok: 0, outputPerMTok: 0 }`). Point to `registerModel`
in the result docs.
