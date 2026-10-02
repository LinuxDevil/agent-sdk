# Configuration

## Agent spec files (`AgentSpec`)

A declarative agent is a YAML (`.yaml`/`.yml`) or JSON (`.json`) file,
validated with zod by `loadSpec()` (`src/spec/schema.ts`). It is the format
`lousho dev` serves and `lousho build` deploys.

| Field            | Type       | Required | Description                                             |
| ---------------- | ---------- | -------- | ------------------------------------------------------- |
| `name`           | `string`   | yes      | Agent name.                                             |
| `prompt`         | `string`   | yes      | System prompt.                                          |
| `provider.type`  | `string`   | yes      | `openai`, `anthropic`, `ollama`, `openrouter` or `mock`. |
| `provider.model` | `string`   | yes      | Model id every call uses (the provider's configured model; an agent's own `settings.model` would override it). |
| `tools`          | `string[]` | no       | Built-in tool names (see below).                       |
| `policy`         | `AgentSpecPolicy` | no | Approvals, guardrails, limits and more, enforced when the spec becomes an agent (see below). |
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
An optional `approval` (`annotations`, `always` or `never`) says which of the server's tools ask for approval; see [Approval for MCP tools](./mcp.md#approval-for-mcp-tools).
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

The `mock` provider needs no credentials and returns canned responses; it is
what the examples and the Quick Start use by default.

## Provider retries and fallback

`createAgent()` retries failed model calls on its own, and can fall back to
other models:

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  retry: { maxRetries: 3, backoff: { initialMs: 1000 } }, // default { maxRetries: 2 }; false turns it off
  fallbackModels: ['anthropic/claude-3-5-haiku-latest'], // tried in order once the retries are used up
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
- A `provider` instance you pass keeps its own retry behaviour; it is wrapped
  in `withRetry()` only when you set `retry`. `fallbackModels` work with it too.
- `fallbackModels` are `provider/model` strings, resolved like `model` when the
  agent is created. The agent runs `withFallback([withRetry(primary), withRetry(fallback1), ...])`:
  every call starts with the primary model.
- `stream()` and `session.stream()` report each retry as a `provider.retry`
  event and each switch as `provider.fallback` (see
  [Streaming](./streaming.md#event-schema-version-1)). `send()` returns the
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
    withRetry(resolveProvider('anthropic/claude-3-5-haiku-latest')),
  ],
  { onFallback: ({ from, to }) => console.warn(`falling back from ${from} to ${to}`) }
);

const agent = createAgent({ prompt: 'You are helpful.', provider });
```

- `withRetry` retries `generate()` and `stream()` (default `maxRetries: 2`)
  on rate limits, timeouts, network errors and 5xx responses, using the same
  classification as `compactProviderError()`. Auth failures, invalid requests
  and context-length errors are not retried; neither is a cancellation. A
  provider's `retryAfterMs` hint (a `Retry-After` header) replaces the backoff
  delay. Pass `retryOn(error, attempt)` to change the rule, `timeoutMs` for a
  per-attempt time limit, and `signal` to stop retrying.
- A `stream()` call is retried only when it rejects. An error inside a stream
  that was already returned is not retried.
- `withFallback` tries each provider in order and rethrows the last error
  when all fail. By default it falls back on any error except a cancellation
  (`fallbackOn` changes that). Each fallback runs on its own `defaultModel`.
  `name` and `defaultModel` report the provider that served the latest call.
- `resilientProvider(provider, { maxRetries, timeout })` applies the
  `LLMProviderConfig` fields of the same names.
- The built-in providers pass their config's `maxRetries` (default 2) to the
  `ai` SDK's own internal retries, which run inside each `withRetry` attempt.
  Build a provider you wrap with `maxRetries: 0`
  (`new OpenAIProvider({ apiKey, maxRetries: 0 })`) to retry in one place.
  `createAgent()` does this for the models it resolves.

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
| `maxSteps` | Passed through to `AgentExecutor.execute()`.                        |
| `limits`   | Budgets of each run: `{ maxTokens?, maxInputTokens?, maxOutputTokens?, maxCostUsd?, maxDurationMs?, maxSteps?, onExceeded? }`. A tripped limit ends the run with `finishReason: 'budget-exceeded'`. See [Budgets](#budgets). |
| `toolConcurrency` | How many tool calls of one model turn run at once: a positive integer or `'unbounded'` (default). See [Parallel tool calls](./api-overview.md#parallel-tool-calls). |
| `skills`   | Skills from `defineSkill()` / `loadSkills()`; see [Skills](./skills.md). |
| `subagents`, `maxSubagentDepth` | Named sub-agents behind one `task` tool, and how deep they may nest (default 1); see [Sub-agents](./sub-agents.md). |
| `store`    | An `AgentStore` (`SqliteStore`, `memoryStore()`, or `{ sessions?, checkpoints?, approvals? }`): the default stores of `agent.session()`, approvals, and `send(message, { sessionId })` runs; `agent.resume(id)` finishes an interrupted one. See [Durable sessions](./sessions.md#durable-sessions). |
| `memory`   | Memory slots from `defineMemory()`: recalled into the system prompt at the start of each run, with `remember_<name>` / `recall_<name>` tools. See [Memory](./memory.md). |
| `approvalStore` | Where a `needsApproval` pause is saved (default: `store.approvals`, else a per-agent `InMemoryApprovalStore`); see [Approvals](./approvals.md). |
| `approve`  | `(call) => boolean`: decide approvals in code instead of pausing. |
| `projectInstructions` | `true` or `{ cwd?, files? }`: append the nearest `AGENTS.md` / `CLAUDE.md` to the instructions (off by default; see [Project instructions](#project-instructions)). |
| `retry`    | `withRetry()` options for failed model calls, or `false`. Default `{ maxRetries: 2 }` for `model` strings; a `provider` instance is wrapped only when set. See [Provider retries and fallback](#provider-retries-and-fallback). |
| `fallbackModels` | `provider/model` strings tried in order when the model still fails after its retries. |
| `hooks`    | `AgentHook[]` run around every model call and tool call, in order, before the compaction hook (see `AgentHook` in the [API overview](./api-overview.md)). |
| `compaction` | `true` (prune old tool results above 90% of the context window) or `{ strategy?, thresholdPercent?, contextWindow?, protectedTokens?, summarizer? }`; `summarizer` (`'provider/model'` or an `LLMProvider`) selects the two-phase strategy. `stream()` reports `compaction.start` / `compaction.done`. See [Context compaction](./compaction.md#compacting-an-agent). |

With neither `model` nor `provider`, `createAgent()` resolves from the
environment: `LOUSHO_MODEL` (a `'provider/model'` string) if set, otherwise
the first provider whose variable is set, checked in this order:
`OPENAI_API_KEY` (`openai/gpt-4o-mini`), `ANTHROPIC_API_KEY`
(`anthropic/claude-3-5-sonnet-latest`), `OPENROUTER_API_KEY`
(`openrouter/openai/gpt-4o-mini`), `OLLAMA_BASE_URL` (`ollama/llama3`). If none
is set it throws an error listing exactly which options or variables fix it.

Misconfiguration errors say how to fix themselves: a missing key names the
variable (`createAgent: OPENAI_API_KEY is not set. ...`), an unknown prefix
lists the supported ones and suggests the closest, and a missing optional peer
dependency prints the exact `npm install` command.

## Budgets

`limits` caps what a run may spend. Set it on `createAgent()` (every run of the
agent) or on `AgentExecutor.execute()` / `stream()`:

| Limit             | Counts |
| ----------------- | ------ |
| `maxTokens`       | Prompt plus completion tokens of the run (`usage.totalTokens`). |
| `maxInputTokens`  | Prompt tokens (`usage.inputTokens`). |
| `maxOutputTokens` | Completion tokens (`usage.outputTokens`). |
| `maxCostUsd`      | Estimated USD (`usage.costUsd`, from the [price table](./api-overview.md#models-tokens-and-cost)). Not checked while a model used has unknown pricing (`costUsd` is `undefined`). |
| `maxDurationMs`   | Wall-clock time of the `execute()` / `stream()` call. |
| `maxSteps`        | Model steps. An alias of the `maxSteps` option: when both are set the stricter wins (the option's tie reports `'max-steps'`); alone, it replaces the default of 10. |

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

`AgentExecutor` is static: call `AgentExecutor.execute(options)`. Only
`agent`, `input` and `provider` are required. Commonly used options:

| Option                                  | Description                                                     |
| --------------------------------------- | --------------------------------------------------------------- |
| `agent`                                 | An `AgentConfig`, usually built with `AgentBuilder`.            |
| `input`                                 | A user message string, or a `Message[]` conversation.            |
| `provider`                              | The `LLMProvider` to generate with.                             |
| `toolRegistry`                          | A `ToolRegistry` holding the tools the agent config refers to.  |
| `maxSteps`                              | Upper bound on LLM/tool steps.                                  |
| `limits`                                | Token, cost, time and step budgets of the run; see [Budgets](#budgets). |
| `temperature`, `maxTokens`              | Generation parameters.                                          |
| `onAgentEvent`                          | Listener for the run's `AgentEvent`s (`run.start`, `tool.start`, `run.done`, ...); see [Streaming](./streaming.md#listening-without-iterating). |
| `approvalStore`, `sessionId`            | Human-in-the-loop approvals (see `resumeAfterApproval()`).       |
| `checkpointStore`                       | Persist/resume execution checkpoints.                           |
| `exporter`                              | A `TraceExporter` for tracing spans (OpenTelemetry GenAI conventions, see [observability](observability.md)). |
| `captureContent`, `redactContent`       | Record message/tool content on `gen_ai.*` span attributes (opt-in) / omit the deprecated content attributes. |
| `onLLMRequest`, `onLLMResponse`, `onToolCall`, `onToolResult` | Observability hooks.                |

It resolves to an `ExecutionResult`: `{ text, messages, toolCalls, usage,
finishReason, steps, approvalId? }`.

## CLI

`lousho dev`, `lousho build`, `lousho mcp` and the other commands, with their
flags, are described in [CLI](./cli.md); `lousho mcp` is also covered in [MCP](./mcp.md#from-the-command-line).
