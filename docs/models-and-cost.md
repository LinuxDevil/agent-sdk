# Models, tokens and cost

## Models and the price table


Dependency-free helpers for budgeting and context decisions.

```ts
import { estimateTokens, estimateCost, getModelInfo, registerModel } from '@lousho/build-ai-agent';

// A custom or self-hosted model: add it (or override a built-in) before use.
registerModel({
  id: 'my-llama',
  provider: 'ollama',
  contextWindow: 32768,
  inputCostPerMTok: 0.2, // optional; omit for unknown or free
  outputCostPerMTok: 0.6,
  cachedInputCostPerMTok: 0.02, // optional: prompt-cache reads; omit to bill them as input
  cacheWriteCostPerMTok: 0.25, // optional: prompt-cache writes; omit to bill them as input
});

const used = estimateTokens([{ role: 'user', content: 'Summarise this report' }], { model: 'my-llama' });
const info = getModelInfo('openai/gpt-4o-mini'); // exact id, `provider/id`, or a dated snapshot
const usd = estimateCost({ inputTokens: used, outputTokens: 500 }, 'my-llama'); // undefined if unpriced
```

- `estimateTokens(input, { model?, estimator? })` is a heuristic (about 4 characters per token for English, more for CJK and other scripts, plus per-message overhead and tool-call JSON). Expect roughly 15-20% error on English: fine for compaction and budgets, not for billing. Plug in a real tokenizer with `setTokenEstimator(fn)` or `options.estimator`.
- `getModelInfo(id)` matches the exact id, then `provider/id`, then dated snapshots (`gpt-4o-mini-2024-07-18` resolves to `gpt-4o-mini`). Unknown models return `undefined`. (In `createAgent({ model })` and `resolveProvider()` strings the `vendor/` model prefix chooses the provider; with OpenRouter use `openrouter/<vendor>/<model>`, e.g. `openrouter/openai/gpt-4o-mini`.)
- `registerModel(info)` adds or overrides an entry; the latest registration wins. Register local models (LM Studio, Ollama, vLLM) with the context window they were loaded with: [compaction](./compaction.md#local-and-unknown-models) and [tool search](./tool-search.md) otherwise assume 128,000 tokens and log a one-time warning.
- `estimateCost(usage, model)` returns USD, or `undefined` (not `0`) when the model or its prices are unknown. `usage.cachedInputTokens` and `usage.cacheWriteTokens`, when given, are the parts of `inputTokens` read from and written to the provider's prompt cache. They are priced at `cachedInputCostPerMTok` and `cacheWriteCostPerMTok`, or at the input price when the model has none. The built-in OpenAI entries carry OpenAI's cached-input price (for example 50% on `gpt-4o-mini`; writes cost nothing extra). The Anthropic entries bill reads at 10% and 5-minute writes at 125% of the input price.

The built-in context windows and prices are a dated snapshot (see the retrieval date and sources at the top of `src/models/modelData.ts`). Providers change prices and models, so override entries with `registerModel` when you need billing-grade numbers.

## Usage and cost of a run

Every `ExecutionResult` (and `agent.send()` result) carries `usage`, the running total of the whole run:

```ts
import { createAgent, formatUsage } from '@lousho/build-ai-agent';

const result = await createAgent({ provider, instructions: 'You compare cities.' }).send('Compare 3 cities');

result.usage.inputTokens; // all model calls of the run, delegated children included
result.usage.costUsd; // number, or undefined if any model used has no known price
result.usage.estimated; // true if some call reported no usage and was estimated
result.usage.byModel['gpt-4o-mini']; // { inputTokens, outputTokens, costUsd?, calls }
result.stepUsage?.[0]; // { step, model, usage, estimated, costUsd? } per model call
console.log(formatUsage(result.usage)); // 1,234 in / 567 out tokens · $0.0042 (2 model calls)
```

- **Reported vs estimated.** Providers report `promptTokens`/`completionTokens`; the built-in providers also pass on `cachedInputTokens`/`cacheWriteTokens`/`reasoningTokens` when the provider reports them (`usage.cachedInputTokens`, `usage.cacheWriteTokens` and `usage.reasoningTokens` only appear then). `inputTokens` always counts the cached and cache-written tokens too. A backend that reports nothing gives `undefined` usage, never zeros. For that step the executor falls back to `estimateTokens` and sets `usage.estimated` (a leading `~` in `formatUsage`). A custom provider should leave `GenerateResult.usage` unset rather than fill in zeros.
- **Cost.** `costUsd` is the sum of the per-call costs: the cost the provider reported (OpenRouter returns `usage.cost` for every model, priced or not), else `estimateCost` for the model. It is `undefined`, never a misleading partial sum, as soon as any model used has unknown pricing; `byModel` shows which ones are priced. In `formatUsage` the cost prints with 4 decimals under $1 (2 at $1 or more), so a run under $0.00005 reads `$0.0000`.
- **Hosted tools.** `usage.hostedToolCalls` counts the calls the provider ran for [hosted tools](./hosted-tools.md) per tool name (e.g. `{ web_search: 2 }`). Their per-call fees are billed by the provider and are not in `costUsd`.
- **Delegation.** A delegated child's usage is added to the parent's totals and `byModel`, and is also shown on its own as `usage.delegated` (`{ inputTokens, outputTokens, totalTokens, costUsd, modelCalls, estimated, runs }`). A [remote sub-agent](./sub-agents.md#remote-sub-agents)'s usage is what the remote agent reports, filed under `byModel['remote:<name>']` with the remote's own `costUsd`.
- **Resume.** A run resumed from a checkpoint, or after an approval, continues from the saved totals instead of restarting at zero. Checkpoints written by older versions start from their saved token counts with an unknown cost.
- **Events and traces.** The `finish` event (and every lifecycle event that carried `usage`) now carries the running totals; `text-complete` also has `stepUsage`, and `onLLMResponse` receives the call's usage as a third argument. The `chat` span's `gen_ai.usage.*` attributes use the same numbers, with `lousho.usage.estimated` set to `true` when they are estimates.
- **Streaming.** `agent.stream()` events carry the same accounting: `step.done` and `run.done` have `usage` with `inputTokens`, `outputTokens`, `estimated` and `costUsd` (run-level also `modelCalls`), alongside the older `promptTokens`/`completionTokens`.
- `promptTokens` and `completionTokens` on `usage` remain as deprecated aliases of `inputTokens` and `outputTokens`.

Prices come from the model registry above, so to get a cost for a custom or fine-tuned model, register it under the id you pass as the model:

```ts
import { registerModel } from '@lousho/build-ai-agent';

registerModel({
  id: 'ft:gpt-4o-mini:acme',
  provider: 'openai',
  contextWindow: 128000,
  inputCostPerMTok: 0.3,
  outputCostPerMTok: 1.2,
});
```

## Prompt caching

Anthropic caches a request prefix only up to a `cache_control` breakpoint that the request marks. OpenAI, and most other providers, cache long prefixes on their own. With `promptCaching: 'auto'` (the default), the built-in `anthropic` provider and the `openrouter` provider mark breakpoints for Claude models (`anthropic/...`, `openrouter/anthropic/...`). They mark three of the four that Anthropic allows:

- the system prompt (the last system message),
- the last tool definition,
- the last user turn. With the `anthropic` provider, a trailing tool-result turn is marked too, so each step of a tool loop reads the conversation so far from the cache.

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openrouter/anthropic/claude-haiku-4.5', instructions: longPolicy }); // promptCaching: 'auto'
const first = await agent.send('Where is order 1042?'); // writes the prefix: usage.cacheWriteTokens
const second = await agent.send('And order 1043?'); // reads it: usage.cachedInputTokens, ~10% of the input price
createAgent({ model: 'anthropic/claude-haiku-4-5', promptCaching: false }); // no breakpoints
```

A cache read costs 10% of the input price. A cache write costs 125% and lasts 5 minutes, so a prompt that is sent only once costs a little more with caching. Anthropic caches only prefixes above a minimum length (1,024 to 4,096 tokens, depending on the model), and shorter prompts are sent uncached. On the `anthropic` provider, tool and system breakpoints need `ai` 6 or 7 (`@ai-sdk/anthropic` 3 or 4). The `@ai-sdk/anthropic` 0.0.x peer pinned for `ai` 4 does not send them. A custom provider gets the setting as `GenerateOptions.promptCaching`.

Measured through OpenRouter on `anthropic/claude-haiku-4.5`, with a 6,834-token prompt (system prompt and one tool):

| Call | Input tokens | Cache read | Cache write | Cost |
| --- | --- | --- | --- | --- |
| `promptCaching: false` | 6,834 | - | - | $0.00686 |
| `'auto'`, first call | 6,834 | - | 6,831 | $0.00857 |
| `'auto'`, second call | 6,834 | 6,831 | - | $0.00071 |
