# Configuration

## Agent spec files (`AgentSpec`)

A declarative agent is a YAML (`.yaml`/`.yml`) or JSON (`.json`) file,
validated with zod by `loadSpec()` (`src/spec/schema.ts`). It is the format
`lousho dev` serves and `lousho build` deploys.

> Snippets on this page leave some names to you: `provider` is any `LLMProvider` (offline: `createMockProvider()`).

| Field            | Type       | Required | Description                                             |
| ---------------- | ---------- | -------- | ------------------------------------------------------- |
| `name`           | `string`   | yes      | Agent name.                                             |
| `prompt`         | `string`   | yes      | System prompt.                                          |
| `provider.type`  | `string`   | yes      | `openai`, `anthropic`, `ollama`, `openrouter` or `mock`. |
| `provider.model` | `string`   | yes      | Model id every call uses (the provider's configured model; an agent's own `settings.model` would override it). |
| `tools`          | `string[]` | no       | Built-in tool names (see below).                       |
| `policy`         | `AgentSpecPolicy` | no | Approvals, guardrails, limits and more, enforced when the spec becomes an agent (see below). |
| `triggers`       | `AgentSpecTrigger[]` | no | What runs the agent on its own — cron schedules (`{ type: 'cron', cron, input, name?, timezone? }`); see [Schedules](./schedules.md) and [Triggers](./triggers.md#cron-schedules). |
| `mcpServers`     | `Record<string, McpServerSpec>` | no | MCP servers the agent uses, keyed by name (see below). |

A missing or invalid field fails with an error naming the exact field, e.g.
`'prompt': Required`.

```yaml
name: support-bot
prompt: You are a friendly support agent.
provider:
  type: openai
  model: gpt-4o-mini
tools:
  - current-date
  - http
```

### Tools a spec can reference

| Name           | Tool                                                 |
| -------------- | ---------------------------------------------------- |
| `http`         | `httpTool` - HTTP requests                           |
| `web-fetch`    | `webFetchTool` - read a public web page as text      |
| `current-date` | `currentDateTool` - current date/time (ISO, UTC)     |
| `day-name`     | `dayNameTool` - day of the week                      |

`github` and `jira` need credentials a spec has no field for; referencing
them throws an error telling you to build the agent with `createAgent()` and
pass a configured tool instead.

### Policy (`policy`)

`specToAgent()` compiles `policy` into `createAgent()` options, so a spec
enforces what it declares. The known fields are validated by `loadSpec()`;
other keys are kept for the other harness generators (Claude Code, Codex, Pi),
which read the raw policy.

| Field              | Compiles to                                   | Description |
| ------------------ | --------------------------------------------- | ----------- |
| `requiresApproval` | `permissions` ([`ask`](./guardrails.md))       | `true`: every tool call pauses for approval. A list: only those tools pause. |
| `guardrails`       | `guardrails` (input and output)               | Built-in guardrail names, or `{ name, ...options }` (table below). |
| `limits`           | `limits` ([budgets](#budgets))                | `maxTokens`, `maxInputTokens`, `maxOutputTokens`, `maxCostUsd`, `maxDurationMs`, `maxSteps`, `onExceeded`. |
| `askQuestion`      | `askQuestion`                                 | `true` adds the built-in `ask_question` tool. |
| `compaction`       | `compaction`                                  | `true`, or `{ thresholdPercent: 0.8 }` (a fraction of the context window, above 0 up to 1). |

```yaml
name: support-bot
prompt: You are a friendly support agent.
provider:
  type: openai
  model: gpt-4o-mini
tools:
  - http
policy:
  requiresApproval: [http]        # or `true` for every tool
  guardrails:
    - secret-scan
    - name: max-length
      maxChars: 4000
      on: input
    - name: deny-topics
      topics: [medical advice, legal advice]
  limits:
    maxTokens: 50000
    maxCostUsd: 0.25
    maxSteps: 10
  askQuestion: true
  compaction:
    thresholdPercent: 0.8
```

Guardrail names (see [Input and output guardrails](./guardrails.md#input-and-output-guardrails)):

| Name           | Options | Does |
| -------------- | ------- | ---- |
| `max-length`   | `maxChars` (default 10000) | Blocks texts longer than `maxChars`. |
| `secret-scan`  | `action` (`block` or `rewrite`), `replacement` | Blocks (or redacts) private keys, OpenAI-style and AWS keys. |
| `regex`        | `pattern` (required), `flags`, `action`, `replacement` | Blocks (or rewrites) texts matching `pattern`. |
| `deny-topics`  | `topics` (required, a list) | Blocks texts that mention a topic (case-insensitive). |
| `llm-judge`    | `model` (required, `"provider/model"`), `instruction` | Asks a model whether the text is acceptable; one call per check. |
| `pii`          | `types` (a list of `email`, `phone`, `credit-card`, `iban`, `us-ssn`, `ip-address`; default all), `action` (default `block`) | Blocks (or rewrites to `[email]`, ...) personal data found by pattern. Heuristic. |
| `secrets`      | `action` (default `rewrite`), `extraPatterns` (a list of regular expressions) | Rewrites (or blocks) API keys, tokens and private keys found by pattern. Heuristic. |
| `prompt-injection` | `model` (optional, `"provider/model"`) | Blocks common prompt-injection phrasing and markers; with `model`, also asks the model. Heuristic. |
| `moderation`   | `model` (required, `"provider/model"`), `categories` (default all) | Asks a model which harmful-content categories apply; one call per check. |

Every guardrail also takes `on`: `input`, `output` or `tools` (a tool call's
arguments), or a list of them. The default is `[input, output]`. An unknown name
or option fails validation, naming the guardrails available and a "did you
mean" suggestion:
`'policy.guardrails.0': unknown guardrail 'deny-topic' (did you mean 'deny-topics'?)`.

`requiresApproval` pauses the run (`finishReason: 'awaiting-approval'`) until
`agent.approvals.resolve()`; before this, a spec that set it ran its tools
without asking. `lousho doctor agent.yaml` prints one line per policy block.

### MCP servers (`mcpServers`)

`mcpServers` declares the MCP servers an agent uses, as a map from a server
name (it namespaces that server's tools) to either a stdio server (`command`,
optional `args` and `env`) or an HTTP server (`url`, optional `headers`).
Each entry sets exactly one of `command` / `url`; `args`/`env` apply only to
stdio and `headers` only to HTTP. The field is validated by `loadSpec()`, and
an invalid entry fails with the entry name in the message, e.g.
`'mcpServers.files': AgentSpec validation failed: missing 'command' (stdio server) or 'url' (HTTP server)`.
An optional `approval` (`always`, the default, `annotations` or `never`) says which of the server's tools ask for approval; see [Approval for MCP tools](./mcp.md#approval-for-mcp-tools).
An optional `deferLoading: true` withholds the server's tools from the model until it finds them with `tool_search`; see [Tool search](./tool-search.md).
An HTTP entry may set `oauth` (`redirectUri`, optional `clientId`, `clientSecret`, `scopes` and `clientName`) to sign in to the server with OAuth instead of a static `Authorization` header; see [MCP servers with OAuth](./oauth.md#mcp-servers-with-oauth).
`lousho doctor` checks each stdio `command` is resolvable.

```yaml
mcpServers:
  filesystem:
    command: npx
    args: [-y, '@modelcontextprotocol/server-filesystem', ./data]
    env:
      LOG_LEVEL: warn
  docs:
    url: https://example.com/mcp
    headers:
      Authorization: Bearer <token>
```

```ts
import { agentSpecSchema, specToAgent, type McpServerSpec } from '@lousho/build-ai-agent';

const filesystem: McpServerSpec = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] };
const spec = agentSpecSchema.parse({
  name: 'support-bot',
  prompt: 'You are a friendly support agent.',
  provider: { type: 'mock', model: 'mock-1' },
  mcpServers: { filesystem, docs: { url: 'https://example.com/mcp' } },
});

// The servers connect on agent.ready() or the first send() / stream().
const agent = specToAgent(spec);
console.log(Object.keys(agent.mcpServers)); // ['filesystem', 'docs']
```

`specToAgent()` passes the servers to `createAgent({ mcpServers })`, described
in [MCP](./mcp.md#use-mcp-servers-in-an-agent), so `lousho dev` and `lousho mcp` agents get their tools.

MCP clients, `connectMcp()`, tool approval and serving an agent over MCP are on their own page: [MCP (Model Context Protocol)](./mcp.md).

## Provider credentials

Real providers are resolved by `resolveProvider('<provider>/<model>')`
(also used for spec files), which reads the credential from the environment:

| Provider     | Environment variable  |
| ------------ | --------------------- |
| `openai`     | `OPENAI_API_KEY`      |
| `anthropic`  | `ANTHROPIC_API_KEY`   |
| `openrouter` | `OPENROUTER_API_KEY`  |
| `ollama`     | `OLLAMA_BASE_URL`     |
| `pi`         | the nested provider's own variable (`pi/openrouter/...` reads `OPENROUTER_API_KEY`) |

The `mock` provider needs no credentials and returns canned responses; it is
what the examples and the Quick Start use by default.

## Provider retries and fallback

`createAgent()` retries failed model calls on its own, and can fall back to
other models. The `vendor/` model prefix chooses the provider; with OpenRouter
use `openrouter/<vendor>/<model>` (e.g. `openrouter/openai/gpt-4o-mini`).

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  retry: { maxRetries: 3, backoff: { initialMs: 1000 } }, // default { maxRetries: 2 }; false turns it off
  fallbackModels: ['anthropic/claude-haiku-4-5'], // tried in order once the retries are used up
});

for await (const event of agent.stream('Hello!')) {
  if (event.type === 'provider.retry') console.warn(`retry ${event.attempt} in ${event.delayMs}ms: ${event.error.message}`);
  if (event.type === 'provider.fallback') console.warn(`falling back from ${event.from} to ${event.to}`);
}
```

- `retry` takes the `withRetry()` options below. It applies to the `model`
  string (or the model picked from the environment) and to every
  `fallbackModels` entry. createAgent builds those providers with the `ai`
  SDK's own retries off (`maxRetries: 0`), so retries happen in one place and
  the default `{ maxRetries: 2 }` makes as many calls as before.
- A `provider` instance you pass keeps its own retry behaviour (for a built-in
  provider, the `ai` SDK's `maxRetries`, default 2) unless you set `retry`.
  With `retry` set, the instance is wrapped in `withRetry()` and that is the
  only retry layer: a built-in provider's calls go out with the `ai` SDK's own
  retries off, so `{ maxRetries: 2 }` makes at most 3 requests, and
  `retry: false` sends each call once. `fallbackModels` work with it too.
- `fallbackModels` are `provider/model` strings, resolved like `model` when the
  agent is created. The agent runs `withFallback([withRetry(primary), withRetry(fallback1), ...])`:
  every call starts with the primary model.
- `stream()` and `session.stream()` report each retry as a `provider.retry`
  event and each switch as `provider.fallback`; its `from` and `to` are provider
  names (such as `openai`), not model ids (see
  [Streaming](./stream-events.md#event-schema-version-1)). `send()` returns the
  final result as before.

To build the same thing by hand, or for providers you construct yourself,
`withRetry(provider, options)` and `withFallback(providers, options)` wrap any
`LLMProvider` and return another one, so they compose and can be passed
anywhere a provider is accepted:

```ts
import { createAgent, resolveProvider, withFallback, withRetry } from '@lousho/build-ai-agent';

const provider = withFallback(
  [
    withRetry(resolveProvider('openai/gpt-4o-mini'), {
      maxRetries: 3,
      backoff: { initialMs: 500, maxMs: 10_000 },
      onRetry: ({ attempt, delayMs }) => console.warn(`retry ${attempt} in ${delayMs}ms`),
    }),
    withRetry(resolveProvider('anthropic/claude-haiku-4-5')),
  ],
  { onFallback: ({ from, to }) => console.warn(`falling back from ${from} to ${to}`) }
);

const agent = createAgent({ prompt: 'You are helpful.', provider });
```

- `withRetry` retries `generate()` and `stream()` (default `maxRetries: 2`)
  on rate limits, timeouts, network errors and 5xx responses, using the same
  classification as `compactProviderError()`. Auth failures, invalid requests
  and context-length errors are not retried; neither is a cancellation. A
  provider's `retryAfterMs` hint (`retry-after-ms` or `Retry-After`, on a 429 or
  a 503) replaces the backoff delay, unless it is longer than `backoff.maxMs`
  (default 30 s): then the call fails at once with a
  `CompactedLLMProviderError` whose `compacted.retryAfterMs` holds the hint, so
  your code decides whether to wait. Pass `retryOn(error, attempt)` to change the rule, `timeoutMs` for a
  per-attempt time limit, and `signal` to stop retrying. For `stream()`,
  `timeoutMs` only bounds the wait for the first chunk: a stream that has
  started is never cut off by it. `idleTimeoutMs` (stream only) fails a stream
  that goes quiet for longer than that between chunks, with a `TimeoutError`
  (retried only while no text or tool call was out).
- A `stream()` call is retried when it rejects, and when its stream fails
  before any output: reasoning chunks and empty text deltas don't count, so a
  local runtime that sends an empty `reasoning-end` and then a 500 (LM Studio)
  is retried. A failure after text, a tool call or the finish is not retried.
  An agent streams its model calls whenever it has an event listener, so this
  is what keeps `agent.stream()` as resilient as `send()`.
- Reasoning streamed before such a failure was already reported. In an agent
  run the failed attempt's reasoning ends with its `reasoning.done`, then
  comes the `provider.retry` event, then the retried attempt's reasoning
  starts again with `reasoning.start`. The step's (and the run's) `reasoning`
  is the successful attempt's only.
- `withFallback` tries each provider in order and rethrows the last error
  when all fail. By default it falls back on any error except a cancellation
  (`fallbackOn` changes that). Each fallback runs on its own `defaultModel`.
  Every call keeps its own fallback state, so concurrent calls never see each
  other's switches. `name` and `defaultModel` are the first provider's; the
  result of a call (and a stream) names the provider and model that served it
  as `servedBy`, and the run books that call's usage and cost under that
  model in `usage.byModel`.
- `resilientProvider(provider, { maxRetries, timeout })` applies the
  `LLMProviderConfig` fields of the same names.
- `withRetry` is the only retry layer: the built-in providers send its calls
  with the `ai` SDK's own retries off, whatever their config's `maxRetries`.
  That `maxRetries` (default 2) applies only to a provider used unwrapped.
- Each retry is recorded on the call's `chat` span as `lousho.retry.count` and
  `lousho.retry.errors` (see [Observability](./observability.md)).

## Rate limits

`withRateLimit(provider, limits)` queues a provider's `generate()` and
`stream()` calls so they stay under client-side limits, so sub-agent fan-out,
flow waves and eval suites cannot burst unbounded model calls. Every limit is
optional:

```ts
import { withRateLimit, resolveProvider } from '@lousho/build-ai-agent';

const provider = withRateLimit(resolveProvider('openai/gpt-4o-mini'), {
  requestsPerMinute: 60, // calls started per rolling minute
  tokensPerMinute: 200_000, // estimated tokens per rolling minute
  maxConcurrent: 4, // calls in flight at once
});
```

- Calls are admitted first in, first out. A call waiting for its turn rejects
  with its `signal`'s reason as soon as it is aborted, and never starts.
- `tokensPerMinute` books each call at `estimateTokens()` of its messages and
  tool definitions plus its `maxTokens`, then re-books it at the usage the
  provider reports. A single call larger than the limit still runs, alone in
  its window.
- A `stream()` holds its `maxConcurrent` slot until the stream ends.
- Invalid limits (not a positive number, or `maxConcurrent` not a whole
  number) throw `LOUSHO_CONFIG_INVALID`.
- Wrap outside `withRetry()` to count a call and its retries as one, or inside
  to count each attempt.
- Pass a `createRateLimiter(limits)` instead of the limits to share one budget
  between several providers.

`createAgent({ rateLimit })` takes the same limits (or a limiter). One budget
covers every model call of the agent's runs, including the sub-agents and
handoff targets a run starts (a sub-agent inherits the lead run's budget, so
its own provider is queued too). Give several agents the same
`createRateLimiter()` to share it across them.

```ts
import { createAgent } from '@lousho/build-ai-agent';

const researcher = createAgent({ model: 'openai/gpt-4o-mini', instructions: 'You research.', description: 'Finds sources' });
createAgent({ model: 'openai/gpt-4o-mini', subagents: { researcher }, rateLimit: { maxConcurrent: 2 } });
```

## `createAgent()` options

| Option         | Description                                                    |
| -------------- | -------------------------------------------------------------- |
| `model`        | A `'provider/model'` string such as `'openai/gpt-4o-mini'`, resolved with `resolveProvider()` (key from the env var above). Alternative to `provider`. |
| `provider`     | An `LLMProvider` instance (real or mock). Alternative to `model`. If you pass both, `provider` is used and `model` becomes the agent's per-run model setting (a bare model id such as `'gpt-4o'`). |
| `instructions` | System prompt. Optional (defaults to `'You are a helpful assistant.'`). |
| `prompt`       | Working alias of `instructions`; passing both is an error.      |
| `tools`    | An array of `defineTool()` results, or a `Record<string, ToolDescriptor>` keyed by the name the agent uses (see [Tools](./tools.md)). |
| `name`     | Agent name (default `'agent'`).                                    |
| `description` | What the agent does, in a sentence. Required when it is used as a sub-agent. |
| `maxSteps` | Passed through to `AgentExecutor.execute()`. A whole number >= 1; anything else throws `LOUSHO_CONFIG_INVALID`. |
| `modelSettings` | Sampling settings sent on every model call: `{ maxTokens?, temperature?, topP?, frequencyPenalty?, presencePenalty?, stop?, seed?, toolChoice? }`. A `send()` / `stream()` call's own `modelSettings` win key by key. See [Model settings](#model-settings). |
| `limits`   | Budgets of each run: `{ maxTokens?, maxInputTokens?, maxOutputTokens?, maxCostUsd?, maxDurationMs?, maxSteps?, onExceeded? }`. A tripped limit ends the run with `finishReason: 'budget-exceeded'`. See [Budgets](#budgets). |
| `toolConcurrency` | How many tool calls of one model turn run at once: a positive integer or `'unbounded'` (default). See [Parallel tool calls](./runs.md#parallel-tool-calls). |
| `skills`   | Skills from `defineSkill()` / `loadSkills()`; see [Skills](./skills.md). |
| `subagents`, `maxSubagentDepth` | Named sub-agents behind one `task` tool, and how deep they may nest (default 1); see [Sub-agents](./sub-agents.md). |
| `handoffs`, `maxHandoffs` | Agents this agent can hand the whole conversation to, one `transfer_to_<name>` tool each, and how many handoffs one run may make (default 5); see [Handoffs](./handoffs.md). |
| `toolSearch` | Tunes [tool search](./tool-search.md) for tools marked `deferLoading`: `{ thresholdPercent?, maxResults?, contextWindow?, search? }`, or `false` to send every tool on every call. |
| `store`    | An `AgentStore` (`SqliteStore`, `memoryStore()`, or `{ sessions?, checkpoints?, approvals? }`): the default stores of `agent.session()`, approvals, and `send(message, { sessionId })` runs; `agent.resume(id)` finishes an interrupted one. See [Durable sessions](./sessions.md#durable-sessions). |
| `memory`   | Memory slots from `defineMemory()`: recalled into the system prompt at the start of each run, with `remember_<name>` / `recall_<name>` tools. See [Memory](./memory.md). |
| `approvalStore` | Where a `needsApproval` pause is saved (default: `store.approvals`, else a per-agent `InMemoryApprovalStore`); see [Approvals](./approvals.md). |
| `approve`  | `(call) => boolean`: decide approvals in code instead of pausing. |
| `projectInstructions` | `true` or `{ cwd?, files? }`: append the nearest `AGENTS.md` / `CLAUDE.md` to the instructions (off by default; see [Project instructions](#project-instructions)). |
| `retry`    | `withRetry()` options for failed model calls, or `false`. Default `{ maxRetries: 2 }` for `model` strings; a `provider` instance is wrapped only when set. See [Provider retries and fallback](#provider-retries-and-fallback). |
| `fallbackModels` | `provider/model` strings tried in order when the model still fails after its retries. |
| `rateLimit` | `{ requestsPerMinute?, tokensPerMinute?, maxConcurrent? }` (or a `createRateLimiter()`): queue the agent's model calls, and its sub-agents' and handoff targets', under one budget. See [Rate limits](#rate-limits). |
| `hooks`    | `AgentHook[]` run around every model call and tool call, in order, before the compaction hook (see [Hooks](./hooks.md)). |
| `compaction` | `true` (prune old tool results above 90% of the context window) or `{ strategy?, thresholdPercent?, contextWindow?, protectedTokens?, reserveOutputTokens?, onCompaction?, summarizer? }`; `summarizer` (`'provider/model'` or an `LLMProvider`) selects the two-phase strategy. `stream()` reports `compaction.start` / `compaction.done`. See [Context compaction](./compaction.md#compacting-an-agent). |

With neither `model` nor `provider`, `createAgent()` resolves from the
environment: `LOUSHO_MODEL` (a `'provider/model'` string) if set, otherwise
the first provider whose variable is set, checked in this order:
`OPENAI_API_KEY` (`openai/gpt-4o-mini`), `ANTHROPIC_API_KEY`
(`anthropic/claude-sonnet-4-5`), `OPENROUTER_API_KEY`
(`openrouter/openai/gpt-4o-mini`), `OLLAMA_BASE_URL` (`ollama/llama3`). If none
is set it throws an error listing exactly which options or variables fix it.

Misconfiguration errors say how to fix themselves: a missing key names the
variable (`createAgent: OPENAI_API_KEY is not set. ...`), an unknown prefix
lists the supported ones and suggests the closest, and a missing optional peer
dependency prints the exact `npm install` command.

## Model settings

`modelSettings` sets the sampling options of every model call an agent makes.
A `send()` or `stream()` call can pass its own, which win key by key over the
agent's:

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  modelSettings: { maxTokens: 1024, temperature: 0.2 },
});

// This run sends maxTokens: 256 and temperature: 0.2.
await agent.send('Summarize the log in one line.', { modelSettings: { maxTokens: 256 } });
```

The keys are `maxTokens`, `temperature`, `topP`, `frequencyPenalty`,
`presencePenalty`, `stop`, `seed` and `toolChoice` (`'auto'`, `'required'`, `'none'` or `{ type: 'function', function: { name } }`; not sent on a call without tools). A key you leave out is not sent at all,
so the provider's own default applies, and so does a value that a wrapping
provider adds to the request. Sub-agents and handoff targets use their own
`modelSettings`, not the lead's. An agent directory can set the same object as
`modelSettings` in its `agent.json`.

The values are checked before any model call, at `createAgent()` and at each
`send()` / `stream()`: `temperature` 0 to 2, `topP` 0 to 1, `frequencyPenalty`
and `presencePenalty` -2 to 2, `maxTokens` a whole number of at least 1, `seed`
a whole number, `stop` an array of strings. A value out of range, or an unknown
key (such as the AI SDK's `maxOutputTokens`), throws a `ConfigurationError`
with code `LOUSHO_CONFIG_INVALID` whose `field` names the key, e.g.
`modelSettings.temperature`. A provider with a narrower range (Anthropic's
`temperature` is 0 to 1) still rejects a value outside it.

### Per-call options

Besides `modelSettings`, a `send()` or `stream()` call can set its own
`maxSteps` (instead of the agent's; a whole number of at least 1, checked like
`createAgent`'s) and `instructions`, which are appended to the agent's
instructions for that run:

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini', instructions: 'You triage support tickets.' });
await agent.send('Summarize the ticket.', { maxSteps: 2, instructions: 'Answer in French.' });
```

The appended `instructions` go with every model call of the run (a handoff
target's too) but are not written to the transcript, so a later call with the
same `sessionId` runs without them unless it passes them again. A run continued
by `agent.approvals.resolve()` or `agent.resume()` uses the agent's `maxSteps`
and instructions.

To share options between agents, type them as `CreateAgentBase` and spread
them into `createAgent()`. Do not use `Partial<CreateAgentConfig>`: that type
keeps `model` / `provider` and `instructions` / `prompt` mutually exclusive,
so TypeScript rejects spreading it next to a literal that sets one of them.

```ts
import { createAgent, type CreateAgentBase } from '@lousho/build-ai-agent';

const shared: CreateAgentBase = { maxSteps: 8, modelSettings: { temperature: 0 } };

function triageAgent(overrides: Partial<CreateAgentBase> = {}) {
  return createAgent({ model: 'openai/gpt-4o-mini', instructions: 'Triage the incident.', ...shared, ...overrides });
}
```

## Budgets

`limits` caps what a run may spend. Set it on `createAgent()` (every run of the
agent) or on `AgentExecutor.execute()` / `stream()`:

| Limit             | Counts |
| ----------------- | ------ |
| `maxTokens`       | Prompt plus completion tokens of the run (`usage.totalTokens`). |
| `maxInputTokens`  | Prompt tokens (`usage.inputTokens`). |
| `maxOutputTokens` | Completion tokens (`usage.outputTokens`). |
| `maxCostUsd`      | USD (`usage.costUsd`): the cost the provider reported for each call (OpenRouter's `usage.cost`), else the [price table](./models-and-cost.md#models-and-the-price-table) estimate. Not checked while a model used has unknown pricing (`costUsd` is `undefined`); a warning is logged once. |
| `maxDurationMs`   | Wall-clock time of the `execute()` / `stream()` call. |
| `maxSteps`        | Model steps. An alias of the `maxSteps` option: when both are set the stricter wins (the option's tie reports `'max-steps'`); alone, it replaces the default of 10. With `output` set, running out of it makes the same forced answer call as `maxSteps` ([Structured output](./structured-output.md#out-of-steps)); the run still ends `'budget-exceeded'`, with `object` when the answer validated. |

Limits are checked before every model call (so after every tool batch) and
after a model call that asks for tools; `maxDurationMs` also aborts an
in-flight model or tool call through the run's signal. A limit trips once the
run reaches it. Usage of sub-agents counts toward their lead's budget: it is
added when the sub-agent returns, so the lead stops before its next model call.
A run that finishes on its own within the step that reached a limit keeps its
own finish reason, like `maxSteps`.

When a limit trips, the run stops with `finishReason: 'budget-exceeded'` and
`result.budget` (`{ limit, value, max, scope }`). Tool calls the model asked
for in that step get a "cancelled" result, so the transcript stays valid, and
with a checkpoint store it is checkpointed as finished, like `'max-steps'`.
`stream()` emits a `budget.exceeded` event before `run.done`. With
`onExceeded: 'throw'` the run rejects with `BudgetExceededError`
(`LOUSHO_BUDGET_EXCEEDED`, with the same `budget`) instead.

```ts
import { BudgetExceededError, createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  provider,
  limits: { maxTokens: 50_000, maxCostUsd: 0.25, maxDurationMs: 60_000 },
});
const result = await agent.send('Research this thoroughly');
if (result.finishReason === 'budget-exceeded') {
  console.warn(`Stopped by ${result.budget?.limit}: ${result.budget?.value} of ${result.budget?.max}`);
}

try {
  await createAgent({ provider, limits: { maxCostUsd: 0.01, onExceeded: 'throw' } }).send('Go');
} catch (error) {
  if (error instanceof BudgetExceededError) console.error(error.budget);
}
```

**Run and session limits.** `createAgent({ limits })` applies to each run on
its own: every `send()`, and every turn of a session, starts from zero.
`agent.session({ id, limits })` adds limits across all of the session's turns:
a turn stops once what the session has spent, in all its turns, reaches a
limit (`budget.scope` is then `'session'`), and later turns stop before calling
the model. What the turns spent (tokens, cost, steps and run time) is saved with
the transcript, as `metadata.sessionUsage` on its last message, so a session
continued from its store keeps its budget. Both apply together; the first limit
reached stops the turn. A turn that was aborted is not counted.

```ts
import { createAgent, memoryStore } from '@lousho/build-ai-agent';

const agent = createAgent({ provider, store: memoryStore(), limits: { maxTokens: 20_000 } });
const session = agent.session({ id: 'user-42', limits: { maxCostUsd: 1 } });
const reply = await session.send('Hello');
if (reply.budget?.scope === 'session') console.log('This conversation used up its budget.');
```

## Project instructions

Many repositories keep guidance for coding agents in an `AGENTS.md` (or
`CLAUDE.md`) file. `createAgent` can append it to the agent's instructions:

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  instructions: 'You review pull requests.',
  provider,
  projectInstructions: true, // or { cwd: './packages/api', files: ['AGENTS.md'] }
});
```

The file is added after your own instructions under the heading
`## Project instructions (from AGENTS.md)`. It is read once, when the agent is
created. The lookup walks up from `cwd` (default `process.cwd()`) and uses the
nearest directory that has one of `files` (default `['AGENTS.md', 'CLAUDE.md']`,
first match wins), stopping at the nearest directory that contains `.git` or at
the filesystem root. Content over 32,000 characters is cut with a truncation
marker. If no file is found nothing is added.

This is **opt-in** on purpose: reading files from disk by default would surprise
people who embed the SDK in a server, where the working directory is not the
project the agent is about. To find the file yourself (for example to show it),
use `loadProjectInstructions({ cwd, files, stopAt, maxChars })`, which returns
`{ path, content }` or `undefined`.

## `AgentExecutor.execute()` options

The options of `AgentExecutor.execute()`, the lower-level entry point, are listed on [the executor API page](./executor-api.md#options-of-agentexecutorexecute).

## CLI

`lousho dev`, `lousho build`, `lousho mcp` and the other commands, with their
flags, are described in [CLI](./cli.md); `lousho mcp` is also covered in [MCP](./mcp.md#from-the-command-line).
