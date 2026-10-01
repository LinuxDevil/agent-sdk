# API Overview

The package root (`@loushy/build-ai-agent`) exports everything below. For
the complete, generated API reference (every export, signature and doc
comment), build the TypeDoc site:

```bash
npm run docs:build   # writes docs/api/index.html
```

How the pieces fit:

```text
┌─────────────────────────────────────┐
│         Your Application            │
│    (React, Vue, Express, etc.)      │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│     @loushy/build-ai-agent          │
│  ┌────────────────────────────┐    │
│  │ createAgent / Builder /     │    │
│  │ Executor (approvals,        │    │
│  │ checkpoints, tracing)       │    │
│  ├────────────────────────────┤    │
│  │ Tools │ Delegation │ MCP    │    │
│  │ Flows │ Guardrails │ Evals  │    │
│  ├────────────────────────────┤    │
│  │       Core Engine          │    │
│  └────────────────────────────┘    │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│  Your LLM Provider & Deploy Target  │
│ (OpenAI/Anthropic/Ollama/OpenRouter,│
│  Node server / Docker / Workers)    │
└─────────────────────────────────────┘
```

## Building and running agents

| Export                        | Description                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- |
| `createAgent(config)`         | Zero-config `{ send(message) }` agent from a `model` string or provider (+ instructions, tools). |
| `AgentBuilder`                | Fluent builder for an `AgentConfig` (`AgentBuilder.create().setName(...)...build()`). |
| `AgentExecutor.execute(opts)` | Static executor: runs an agent (LLM + tool-calling loop) and resolves to an `ExecutionResult`. |
| `AgentType`                   | Deprecated, no runtime effect: agents need no type (removed next minor).    |
| `resumeAfterApproval()`       | Resume an execution paused for human approval.                             |
| `InMemoryApprovalStore`       | Process-local `ApprovalStore`; the default store of `createAgent()` agents. |
| `StorageServiceApprovalStore`, `LocalStorageCheckpointStore` | File-backed approval and checkpoint stores over a `StorageService` (see [Approvals](./approvals.md), [Durable execution](./durable-execution.md)). |
| `SqliteStore` (from `/sqlite`) | Sessions, checkpoints and approvals in one SQLite file (see [Sessions](./sessions.md#choosing-a-store)). |
| `AgentStore`, `memoryStore()` | The `createAgent({ store })` option: `{ sessions?, checkpoints?, approvals? }`, and an in-memory one (see [Sessions](./sessions.md#choosing-a-store)). |
| `SessionAwaitingApprovalError` | Thrown by `execute()` when its `sessionId` is paused on an approval (see [Durable execution](./durable-execution.md)). |
| `SDKError`, `ERROR_CODES`    | Base class of the SDK's errors: a stable `code`, a `hint` and a `docs` link (see [Errors](./errors.md)). |
| `createDelegateTool()`        | Wrap a child agent as a tool for multi-agent delegation.                    |

### UI bindings

`@loushy/build-ai-agent/react` exports `useLoushyAgent(source, options?)`, a
React hook that runs an agent in process (`{ agent, sessionId? }`) or over HTTP
(`{ url }`) and returns `messages`, `status`, `pendingApproval`,
`send()`, `stop()`, `approve()` and `reject()`. Its framework-neutral parts,
`reduceAgentEvents()` and `parseEventStream()`, are exported too. See
[React](./react.md).

### Sub-agents

Pass `subagents: { researcher, writer }` (agents from `createAgent()` with a
`description`, or a `{ list, resolve }` catalog) to `createAgent()` or
`AgentExecutor.execute()`: the lead gets one `task` tool and a prompt listing,
each sub-agent runs on the task prompt alone, and it inherits the lead run's
signal, hooks (`ctx.subagent`), tracing, approval store and `onEvent`
(`event.subagent`). `maxSubagentDepth` (default 1) bounds nesting. See
[Sub-agents](./sub-agents.md).

### Approvals

A `createAgent()` agent pauses on a `needsApproval` tool instead of failing:
`send()` (and `session.send()`) resolves with `finishReason: 'awaiting-approval'`
and an `approvalId`. `agent.approvals.list()` returns the pending calls and
`agent.approvals.resolve({ id, approved, note? })` runs or rejects the call and
resolves with the continued run's result (continuing the session it paused
in). Pauses are kept in a per-agent `InMemoryApprovalStore` unless you pass
`approvalStore` (e.g. `SqliteStore.approvals`) or a `store`; `approve: (call) => boolean | string`
decides each call in code without pausing (`stream()` still ends at the
pause). With `askQuestion: true` the agent can ask the user a question
(`kind: 'question'`), answered with `agent.approvals.answer({ id, answer })`.
See [Approvals](./approvals.md).

### Structured output

Pass `output: zodSchema` to `createAgent()` (or `AgentExecutor.execute()` /
`stream()`): the final reply must be a JSON object matching the schema, and
`send()` / `run.result` resolve with it validated as `result.object`, typed
`z.output<typeof schema>` (`result.text` keeps the raw JSON). Tools still run
first. Each model call carries a `responseFormat: { type: 'json', schema }`
hint, which the `ai`-SDK providers map to JSON mode. An invalid reply gets one
repair step listing the issues (it counts against `maxSteps`); if that is
invalid too, the run ends with `finishReason: 'output-invalid'` and
`outputError: { message, issues }`. See [Structured output](./structured-output.md).

### Skills

Pass `skills: [defineSkill({ name, description, content }), ...(await loadSkills(dir))]` to
`createAgent()` or `AgentExecutor.execute()`: only names and descriptions go in
the system prompt and the model loads bodies through an auto-registered
`load_skill` tool. See [Skills](./skills.md).

### Durable execution

`sessionId` + `checkpointStore` make a run crash-safe and a session
multi-turn: the run is checkpointed after every model response, every tool
result and every pause, and calling `execute()` again with the same
`sessionId` resumes an unfinished run (without re-calling the model for a
turn it already has), continues a finished conversation with the new
input, or throws `SessionAwaitingApprovalError` while an approval is
pending. Tools run at-least-once across a crash; `execute` receives the
call's `toolCallId` to use as an idempotency key. See
[Durable execution](./durable-execution.md) for the exact guarantees.

### Cancellation

Pass an `AbortSignal` to stop a run: `agent.send(input, { signal })`,
`AgentExecutor.execute({ ..., signal })` or
`resumeAfterApproval(..., { signal })`.

```ts
import { createAgent, createMockProvider } from '@loushy/build-ai-agent';
const agent = createAgent({ prompt: 'You are helpful.', provider: createMockProvider() });
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000); // e.g. from a Stop button
const result = await agent.send('Write a long report', { signal: controller.signal });
console.log(result.finishReason); // 'aborted' if it was cancelled, else 'stop'
```

For a time limit, use `AbortSignal.timeout(ms)`:

```ts
import { createAgent, createMockProvider } from '@loushy/build-ai-agent';
const agent = createAgent({ prompt: 'You are helpful.', provider: createMockProvider() });
const result = await agent.send('Summarize this', { signal: AbortSignal.timeout(30_000) });
```

How it behaves:

- The signal is checked before every model call and every tool call. It is
  passed to the provider (`GenerateOptions.signal`, sent to the `ai` SDK as
  `abortSignal`) and to each tool as `execute(args, { abortSignal })`, so
  in-flight work can stop early. The built-in `httpTool` passes it to
  `fetch`, and agents created with `createDelegateTool()` are aborted along
  with their parent.
- An aborted run **resolves** (it does not reject) with
  `finishReason: 'aborted'` and the messages and steps so far. A rejection
  caused by the abort, such as an `AbortError`, is not treated as a failure:
  it is not retried (including by `retry()`) and is not compacted into a
  provider error.
- `onEvent` receives an `abort` event (its `abortReason` is the signal's
  `reason`), then `finish` with `finishReason: 'aborted'`.
- With `sessionId` + `checkpointStore`, the state is checkpointed. Calling
  `execute()` again with the same `sessionId` resumes where the run stopped;
  new `input` is appended as the next user message (see
  [Durable execution](./durable-execution.md)). Tool calls the run never
  reached get an `{ error }` result saying they were cancelled, so the
  conversation stays valid for the provider.
- An already-aborted signal returns at once without calling the provider.

### Finish reasons

`result.finishReason` says why a run ended: the model's own reason for its last
turn (`'stop'`, `'length'`, `'tool_calls'`, `'content_filter'`, `'error'`),
`'awaiting-approval'` (paused on a tool call that needs a human), `'aborted'`
(cancelled with `signal`), `'max-steps'`, or `'output-invalid'` (the reply
did not match the `output` schema even after the repair step, see
[Structured output](./structured-output.md)). `'max-steps'` means the `maxSteps`
budget (default 10) ran out while the model still wanted to continue, so the
reply may be empty or partial; a run that finishes naturally within the budget
keeps its `'stop'`. Steps carried over by `initialSteps` or an approval resume
count against the budget, and `result.steps` is the number of steps taken. The
same reason is on the `finish` event and on `run.done` in
[streaming](streaming.md).

```ts
import { createAgent, createMockProvider } from '@loushy/build-ai-agent';
const agent = createAgent({ prompt: 'You are helpful.', provider: createMockProvider(), maxSteps: 3 });
const result = await agent.send('Research this thoroughly');
if (result.finishReason === 'max-steps') console.warn(`Gave up after ${result.steps} steps`);
```

### Parallel tool calls

When the model asks for several tools in one turn, they run concurrently.
`toolConcurrency` (on `createAgent()` and `AgentExecutor.execute()`) caps how
many run at once: a positive integer, or `'unbounded'` (the default). Use `1`
for strictly sequential execution, e.g. when your tools share state that is
not safe to touch concurrently.

```ts
import { createAgent, createMockProvider, defineTool } from '@loushy/build-ai-agent';
import { z } from 'zod';

const getWeather = defineTool({
  name: 'get_weather',
  description: 'Current weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21 }),
});

const agent = createAgent({
  prompt: 'You are a travel assistant.',
  provider: createMockProvider(),
  tools: [getWeather],
  toolConcurrency: 4, // at most 4 tool calls of a turn in flight
});
```

Guarantees, whatever the limit:

- **Transcript order is call order.** Tool results are appended in the order
  the model requested the calls, not the order they finish, so the next
  provider request is deterministic.
- **Events.** Calls start in call order. A call's `tool-call` event,
  `onToolCall`, argument validation, `preToolCall` hooks and `needsApproval`
  check run just before it starts, one call at a time. Its `tool-result`
  event fires when it finishes, so results arrive in completion order. With
  `toolConcurrency: 1` events alternate call/result exactly as before.
- **Approvals.** The first call that needs approval stops the batch: the
  calls before it run (concurrently) and their results are recorded, then the
  run pauses on that call (`finishReason: 'awaiting-approval'`). Calls after
  it never start in this run. `resumeAfterApproval()` records the paused
  call's result (or rejection) and then runs those later calls the same way,
  so every call of the turn gets exactly one result - see
  [Durable execution](./durable-execution.md#approvals-in-the-middle-of-a-tool-batch).
- **Failures are isolated.** A tool that throws gets its own error result;
  its siblings carry on. A propagating error (`PropagatingToolError`, such as
  the delegation depth guard, or a throwing hook) stops new calls from
  starting, waits for the running ones to settle, then rejects the run. No
  tool is left running detached.
- **Cancellation.** An abort while a batch runs resolves with
  `finishReason: 'aborted'`. Calls that finished keep their results; the rest
  get a "cancelled" result. Running tools see the abort through their
  `abortSignal`.
- **Checkpoints.** With `sessionId` + `checkpointStore`, the model's turn is
  checkpointed before any call starts, then again each time the in-order run
  of finished calls grows (with `1`, after every call). A resumed run never
  runs a recorded call again, and never asks the model again for a turn it
  already checkpointed.

## Declarative specs

| Export             | Description                                                    |
| ------------------ | -------------------------------------------------------------- |
| `loadSpec(path)`   | Load and validate a `.yaml`/`.yml`/`.json` `AgentSpec` file.  |
| `agentSpecSchema`  | The zod schema for `AgentSpec`.                               |
| `specToAgent(spec)` | Turn an `AgentSpec` into a live `createAgent()` agent.        |

## Providers

| Export                          | Description                                                  |
| ------------------------------- | ------------------------------------------------------------ |
| `resolveProvider('p/model')`    | Build a real provider from env-var credentials.             |
| `LLMProviderRegistry`           | Registry of provider factories (`create`, `register`, `has`). |
| `OpenAIProvider`, `AnthropicProvider`, `OllamaProvider`, `OpenRouterProvider` | Provider classes. |
| `createMockProvider()`, `MockLLMProvider` | Deterministic mock provider for tests and demos.   |
| `withRetry(provider, opts?)`, `withFallback(providers, opts?)` | Retry transient provider failures with backoff; fall back to the next provider. See [Configuration](configuration.md#provider-retries-and-fallback). |
| `textOf(message)`               | The text of a message: its string `content`, or its text parts joined. |

`Message.content` is a string or a list of `ContentPart`s (`text`, `image`,
`file`); the built-in providers send image parts on user messages. See
[Multimodal input](./providers.md#multimodal-input).

See [Providers](./providers.md) for how a model string is resolved and which model runs.

## Testing

Exported from `@loushy/build-ai-agent/testing` (see [Testing agents](testing.md)).

| Export                | Description                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `mockModel(script)`   | Scripted, deterministic `LLMProvider` that records every request (`calls`, `lastCall`, `reset()`, `assertExhausted()`). |
| `Mock*Repository`     | In-memory repository mocks (`MockAgentRepository`, `MockSessionRepository`, ...).        |

## Tools

| Export                                       | Description                                   |
| -------------------------------------------- | --------------------------------------------- |
| `defineTool({ name, description, input, execute, ... })` | Define a tool; `execute`/`needsApproval` args are inferred from the zod `input`. Accepted by `createAgent({ tools: [...] })`, `ToolRegistry.register(tool)` and `AgentBuilder.addTool(tool)`. |
| `ToolInput<typeof t>`, `ToolOutput<typeof t>` | Argument and result types of a defined tool. |
| `ToolRegistry`                               | Holds the tools an agent config refers to (advanced: `register(tool)` or `register(name, descriptor)`). |
| `httpTool`, `currentDateTool`, `dayNameTool` | Built-in tools.                               |
| `createFsTools(fs, options?)`, `createShellTool(shell, options?)` | Workspace tools (`read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `shell`) over an `FsProvider` / `ShellProvider`. See [Workspace tools](workspace-tools.md). |
| `NodeWorkspace`, `MemoryWorkspace`, `SandboxShell` | Workspace providers: a real directory (paths confined to `root`, minimal shell env), an in-memory tree with a scripted `exec` for tests, and a `ShellProvider` over a `SandboxAdapter` (Docker). |
| `createTodoTools({ store?, onChange? })`     | `todo_write` / `todo_read` tools (plus `getTodos()`) so agents can plan and track multi-step work; see [Todo tools](#todo-tools). |
| `connectMcp(servers, options?)`             | Connect MCP servers from config (stdio or HTTP) and load their tools; see [Connect MCP servers](./configuration.md#connect-mcp-servers-mcpservers-connectmcp). |
| `loadMcpTools(client, connectionName)`       | Load a connected MCP server's tools as `ToolDescriptor`s. Available from the package root, `@loushy/build-ai-agent/tools`, and `@loushy/build-ai-agent/mcp`. |

See [Tools](./tools.md) for a guide to defining and registering tools.

```ts
import { defineTool } from '@loushy/build-ai-agent';
import { z } from 'zod';

const sendEmail = defineTool({
  name: 'send_email', // 1-64 chars: letters, digits, _ and -
  description: 'Send an email',
  input: z.object({ to: z.string().email(), subject: z.string() }),
  needsApproval: ({ to }) => !to.endsWith('@mycompany.com'), // `to` is typed
  async execute({ to, subject }) {
    return { messageId: `${to}:${subject}` };
  },
});
```

Optional fields: `displayName`, `needsApproval` (boolean or predicate),
`requiresSandbox` and `sandboxExecute`. Defining a tool validates its name,
description and zod `input` immediately; registering two tools with the same
name throws an error naming the conflict.

A defined tool carries its schema as `inputSchema` (the same zod schema as
`input`) and its `execute` function directly. These are the canonical fields of
a `ToolDescriptor`; the `.tool` object (an `ai` v4 `{ description, parameters,
execute }`) is legacy, still built for compatibility, and used only for
descriptors that do not set `inputSchema` / `execute`.

```ts
import { loadMcpTools } from '@loushy/build-ai-agent/mcp';

const tools = await loadMcpTools(mcpClient, 'my-server');
```

**Schema support.** Each tool's JSON Schema `inputSchema` is converted to a
zod schema, and the model's arguments are validated against it before the
server is called. The converter handles `type` (including arrays such as
`["string", "null"]`), `enum` with mixed types, `const`, `anyOf` / `oneOf`
(a union; `anyOf: [X, { type: "null" }]` becomes `X.nullable()`), `allOf`
(merge / intersection), local `$ref` into `$defs` / `definitions`,
`properties` / `required`, `additionalProperties` (boolean or schema), `items`,
`default`, and the constraints `minimum`, `maximum`, `exclusiveMinimum`,
`exclusiveMaximum`, `minLength`, `maxLength`, `pattern`, `minItems` and
`maxItems`. Where JSON Schema is ambiguous the conversion is permissive:
unknown keywords, empty schemas, tuple `items` and unresolvable refs become
`z.any()`, a recursive `$ref` is expanded once and `z.any()` is used for the
inner occurrence, an invalid `pattern` regex is skipped, and objects keep
extra properties unless `additionalProperties` is `false`. The converter never
throws on schema content.

**Skipped tools.** If one tool still cannot be converted, only that tool is
skipped; the rest of the server's tools load. Pass a `logger` to receive a
warning naming the server, the tool and the reason, and `onSkip` to collect
what was left out:

```ts
import { loadMcpTools, type SkippedMcpTool } from '@loushy/build-ai-agent/mcp';

const skipped: SkippedMcpTool[] = [];
const tools = await loadMcpTools(mcpClient, 'my-server', {
  logger: console,
  onSkip: (tool) => skipped.push(tool), // { name, reason }
});
```

**Results.** An MCP result with `isError: true` is a normal tool failure: the
model receives `{ "error": "McpToolError", "toolName": "...", "message": "..." }`
where `message` is the server's text content. Successful results are
JSON-serializable: if the server returns `structuredContent` it is the result
object; otherwise the result is `{ text, content }`, where `text` joins all
text parts and `content` keeps every part in order (`text`, `image`, `audio`,
`resource`, `resource_link`; an unrecognised part type is kept as
`{ type: 'unknown', raw }`). When `structuredContent` arrives together with
non-text parts the result is `{ structuredContent, text, content }` with
`content` holding only the non-text parts, so images, audio and resources are
never dropped.

### Todo tools

`createTodoTools(options?)` gives long-running agents a plan to track:
`todo_write` replaces the whole list (`{ id?, content, status }` items, status
`pending` | `in_progress` | `completed`, at most one `in_progress`) and returns
the list plus counts; `todo_read` returns it. Ids are assigned automatically and
stay stable when a later write repeats an item's content. Invalid lists (for
example two `in_progress`) reach the model as a structured tool error so it can
retry. The list lives in memory per call; pass `store` (`{ get, set }`) to
persist it, and `onChange` to update a UI.

```ts
import { createAgent, createTodoTools, type TodoStore } from '@loushy/build-ai-agent';

const todos = createTodoTools({ onChange: (list) => console.log(list.length, 'todos') });
const planner = createAgent({ prompt: 'Plan multi-step work, then do it.', provider, tools: todos.tools });

await planner.send('Migrate the repo to ESM');
console.log(await todos.getTodos()); // [{ id: 'todo_1', content: '...', status: 'completed' }, ...]

// Persist the list somewhere else:
let saved: Awaited<ReturnType<TodoStore['get']>> = [];
createTodoTools({ store: { get: () => saved, set: (next) => void (saved = next) } });
```

### Tool errors

A tool call can fail in two ways. In both, the run continues and the model
receives a structured JSON error as the tool result (never the string `null`),
so it can recover. `tool-result` events, tracing, `onToolResult` and
`postToolCall` hooks see the call as an error.

**Argument validation.** Before a tool runs, the model's arguments are parsed with the tool's zod
`inputSchema` (for a legacy descriptor, `tool.parameters`). Validation happens first, so pre-tool hooks, the
`needsApproval` predicate and `execute` all receive the **parsed** value
(defaults, coercions and transforms applied). Tools without a zod schema are
passed through unchanged.

If the arguments do not match, `execute` is not called, the run continues, and
the model receives a structured error as the tool result so it can retry
(`tool-result` events, tracing and `postToolCall` hooks see it as an error
result; `preToolCall` hooks are skipped because there is no valid call):

```json
{
  "error": "ToolArgumentsValidationError",
  "toolName": "sendEmail",
  "message": "Invalid arguments for tool 'sendEmail': 2 issues (to: Required; count: Expected number, received string)",
  "kind": "validation",
  "issues": [
    { "path": "to", "message": "Required" },
    { "path": "count", "message": "Expected number, received string" }
  ]
}
```

`ToolArgumentsValidationError` (with a typed `issues` array) is exported from
the package root.

**Thrown errors.** If `execute` throws, the model receives the error name,
the tool name and the message only (never a stack trace). Messages are capped
at 2,000 characters and end with `... (truncated)` when cut:

```json
{ "error": "TypeError", "toolName": "search", "message": "query must not be empty", "kind": "execution" }
```

Every other failure (unknown tool, rejected approval, a call that was not run,
an MCP error, a refused sandboxed tool) uses the same `{ error, toolName,
message, kind }` shape; see [Errors](./tools.md#errors) for the `kind` values.

Errors extending `PropagatingToolError` (for example the delegation depth
guard) are the exception: they are rethrown and abort the run instead of being
shown to the model.

## Models, tokens and cost

Dependency-free helpers for budgeting and context decisions.

```ts
import { estimateTokens, estimateCost, getModelInfo, registerModel } from '@loushy/build-ai-agent';

// A custom or self-hosted model: add it (or override a built-in) before use.
registerModel({
  id: 'my-llama',
  provider: 'ollama',
  contextWindow: 32768,
  inputCostPerMTok: 0.2, // optional; omit for unknown or free
  outputCostPerMTok: 0.6,
});

const used = estimateTokens([{ role: 'user', content: 'Summarise this report' }], { model: 'my-llama' });
const info = getModelInfo('openai/gpt-4o-mini'); // exact id, `provider/id`, or a dated snapshot
const usd = estimateCost({ inputTokens: used, outputTokens: 500 }, 'my-llama'); // undefined if unpriced
```

- `estimateTokens(input, { model?, estimator? })` is a heuristic (about 4 characters per token for English, more for CJK and other scripts, plus per-message overhead and tool-call JSON). Expect roughly 15-20% error on English: fine for compaction and budgets, not for billing. Plug in a real tokenizer with `setTokenEstimator(fn)` or `options.estimator`.
- `getModelInfo(id)` matches the exact id, then `provider/id`, then dated snapshots (`gpt-4o-mini-2024-07-18` resolves to `gpt-4o-mini`). Unknown models return `undefined`.
- `registerModel(info)` adds or overrides an entry; the latest registration wins.
- `estimateCost(usage, model)` returns USD, or `undefined` (not `0`) when the model or its prices are unknown.

The built-in context windows and prices are a dated snapshot (see the retrieval date and sources at the top of `src/models/modelData.ts`). Providers change prices and models, so override entries with `registerModel` when you need billing-grade numbers.

### Usage and cost of a run

Every `ExecutionResult` (and `agent.send()` result) carries `usage`, the running total of the whole run:

```ts
import { AgentExecutor, formatUsage } from '@loushy/build-ai-agent';

const result = await AgentExecutor.execute({ agent, input: 'Compare 3 cities', provider });

result.usage.inputTokens; // all model calls of the run, delegated children included
result.usage.costUsd; // number, or undefined if any model used has no known price
result.usage.estimated; // true if some call reported no usage and was estimated
result.usage.byModel['gpt-4o-mini']; // { inputTokens, outputTokens, costUsd?, calls }
result.stepUsage?.[0]; // { step, model, usage, estimated, costUsd? } per model call
console.log(formatUsage(result.usage)); // 1,234 in / 567 out tokens · $0.0042 (2 model calls)
```

- **Reported vs estimated.** Providers report `promptTokens`/`completionTokens`; the built-in providers also pass on `cachedInputTokens`/`reasoningTokens` when the 'ai' SDK's provider metadata carries them (`usage.cachedInputTokens` and `usage.reasoningTokens` only appear then). A backend that reports nothing gives `undefined` usage, never zeros. For that step the executor falls back to `estimateTokens` and sets `usage.estimated` (a leading `~` in `formatUsage`). A custom provider should leave `GenerateResult.usage` unset rather than fill in zeros.
- **Cost.** `costUsd` is the sum of `estimateCost` per model. It is `undefined`, never a misleading partial sum, as soon as any model used has unknown pricing; `byModel` shows which ones are priced.
- **Delegation.** A delegated child's usage is added to the parent's totals and `byModel`, and is also shown on its own as `usage.delegated` (`{ inputTokens, outputTokens, totalTokens, costUsd, modelCalls, estimated, runs }`).
- **Resume.** A run resumed from a checkpoint, or after an approval, continues from the saved totals instead of restarting at zero. Checkpoints written by older versions start from their saved token counts with an unknown cost.
- **Events and traces.** The `finish` event (and every lifecycle event that carried `usage`) now carries the running totals; `text-complete` also has `stepUsage`, and `onLLMResponse` receives the call's usage as a third argument. The `chat` span's `gen_ai.usage.*` attributes use the same numbers, with `loushy.usage.estimated` set to `true` when they are estimates.
- **Streaming.** `agent.stream()` events carry the same accounting: `step.done` and `run.done` have `usage` with `inputTokens`, `outputTokens`, `estimated` and `costUsd` (run-level also `modelCalls`), alongside the older `promptTokens`/`completionTokens`.
- `promptTokens` and `completionTokens` on `usage` remain as deprecated aliases of `inputTokens` and `outputTokens`.

Prices come from the model registry above, so to get a cost for a custom or fine-tuned model, register it under the id you pass as the model:

```ts
import { registerModel } from '@loushy/build-ai-agent';

registerModel({
  id: 'ft:gpt-4o-mini:acme',
  provider: 'openai',
  contextWindow: 128000,
  inputCostPerMTok: 0.3,
  outputCostPerMTok: 1.2,
});
```

### Context compaction

`createCompactionHook({ thresholdPercent?, contextWindow?, protectedTokens?, strategy?, onCompaction? })`
returns an `AgentHook` that, before each model call above 90% (by default) of
the model's context window, replaces tool results older than the newest
40,000 tokens with a `[pruned: <tool> result, N chars]` marker. It edits the
run's transcript in place, so pruning persists in checkpoints and
`result.messages`. `twoPhaseStrategy({ model })` (recommended) prunes first
and, if the run is still too big, replaces old turns with a summary written
by `model`; `summarizeStrategy()` only summarizes. `pinMessage(message)` marks
a message that is never pruned or summarized. `compactMessages(messages, options)`
does the same once, by hand (async), and `CompactionStrategy` is the
pluggable interface (`compact()` may be async). `createAgent({ compaction: true })`
installs the hook on an agent (`createAgent({ hooks })` takes any other
`AgentHook`s), and `stream()` emits `compaction.start` / `compaction.done`.
See [Context compaction](./compaction.md).

## Flows, evals, observability and security

- `FlowBuilder` / `FlowExecutor` - multi-step workflow graphs; see [Flows](./flows.md).
- `defineEval()`, scorers such as `exactMatch`, `toolCallOrder` and `budget`, checks such
  as `includes` and `atLeast`, and `llmJudge()` - agent evals run under vitest
  or `loushy eval`; see [Evals](evals.md).
- `withSpan()` and `TraceExporter` - tracing for `AgentExecutor.execute()`.
  `TraceExporter` is a bring-your-own-exporter interface (no exporter
  ships by default); for real OpenTelemetry spans, import
  `createOtelTraceExporter()` from the `@loushy/build-ai-agent/otel`
  subpath (requires the optional peer dependency `@opentelemetry/api`)
  instead of hand-rolling the OTel bridge - see
  `examples/tracing/run-otel.ts`. Spans follow the OpenTelemetry GenAI
  semantic conventions (flows are traced too); see
  [observability](observability.md).
- `NoopSandbox` / `SubprocessSandbox` - sandboxing for tools that opt in via
  `requiresSandbox`; `runGuardrails()` and guardrails such as
  `createCommandGuardrail()`, `createDiffSizeGuardrail()` and
  `secretScanGuardrail`. See [Guardrails and sandboxing](./guardrails.md).
- `HookRegistry`, `AgentHook`, `HookContext`, `ToolCallHookContext`,
  `GenerateHookContext` - pre/post agent hooks (run before/after a tool call
  or an LLM `generate`, can mutate args/messages/results or throw to abort
  the step). Available from the package root and from
  `@loushy/build-ai-agent/hooks`. Agent Forge's canvas hook editor
  ([docs/agent-forge.md](./agent-forge.md#hooks)) compiles the hooks a user
  attaches to a node into a `HookRegistry` this way, run sandboxed via
  `SandboxAdapter` rather than in the host process.

  ```ts
  import { HookRegistry, type AgentHook } from '@loushy/build-ai-agent/hooks';

  const redactPii: AgentHook = {
    name: 'redact-pii',
    async preToolCall(ctx) {
      // mutate ctx.args, or throw to abort the tool call before it runs
    },
  };
  const hooks = new HookRegistry();
  hooks.register(redactPii);
  ```
- `EncryptionUtils`, `sha256`, `StorageService`, `renderTemplate`,
  `MemoryManager` - supporting utilities; see [Utilities](./utilities.md).

### Flow expressions

`oneOf` branch conditions (and the Agent Forge router node's branch conditions)
and `evaluator` node expressions are evaluated by a small built-in expression
evaluator. It never compiles or runs host code: there is no `eval`,
`new Function` or `vm` in `src/flows`. `{{name}}` placeholders are bound as
values, never pasted into the expression text: a bare `{{score}} >= 90` uses the
variable's value, and inside a string literal, `'{{classify}}' === 'refund'`
interpolates the value's text into that literal after the expression has been
tokenized. A variable whose value contains quotes, backslashes or operators
(for example `x' === 'x' || 'a`) is therefore just data and cannot change the
condition's logic. A missing or `null` variable is an empty string inside a
literal; used bare it contributes nothing, so `{{missing}} >= 90` is a syntax
error and the condition counts as not matched. The expression is evaluated
against the flow's variables.

| Form | Examples |
| --- | --- |
| Literals | `'text'`, `"text"`, `42`, `1.5`, `true`, `false`, `null` |
| Variables and paths | `score`, `user.address.city`, `user['first-name']`, `items[0].id` |
| Length | `name.length`, `items.length` (strings and arrays) |
| Comparison | `==`, `===`, `!=`, `!==`, `<`, `<=`, `>`, `>=` |
| Logical | `&&`, `\|\|`, `!` (short-circuiting, return the deciding operand) |
| Arithmetic | `+`, `-`, `*`, `/`, `%`, unary `-` and `+` |
| Grouping | `( ... )` |
| Allow-listed methods | `s.includes(x)`, `s.startsWith(x)`, `s.endsWith(x)` on strings; `list.includes(x)` on arrays (exactly one argument) |

Precedence, loosest to tightest: `||`, `&&`, equality, relational, `+ -`,
`* / %`, unary, member access.

Not supported, and rejected with an `ExpressionError` that names the
expression, the character position and this list of supported forms: any other
function or method call, assignment (`=`, `+=`, `++`), ternaries, template
strings, object/array literals, access to `constructor`, `__proto__` or
`prototype`, and globals (`process`, `require`, `globalThis`, ...). Only a
flow's own variables, and only their own properties, are reachable.

Failure behaviour is unchanged: a `oneOf` condition that cannot be evaluated
counts as not matched (`false`), and an `evaluator` expression that cannot be
evaluated fails the flow with `Failed to evaluate expression: ...`, including
the `ExpressionError` detail.

## Triggers

Trigger adapters (`@loushy/build-ai-agent/triggers`) wake an agent up from an
inbound webhook, a schedule or a Slack message. Wire any of them with
`listen(agent, onEvent)`, where `onEvent` runs the agent.

### Webhook authentication

`WebhookTriggerAdapter` starts an HTTP server. **Always set `auth` for a
webhook that is reachable from outside your machine**: without it, anyone who
can reach the port can run your agent (and spend your tokens). If you listen
on a non-loopback host with no `auth`, the adapter logs a one-time warning
through `options.logger`.

```ts
import { createAgent, createMockProvider } from '@loushy/build-ai-agent';
import { WebhookTriggerAdapter } from '@loushy/build-ai-agent/triggers';

const agent = createAgent({ prompt: 'You are helpful.', provider: createMockProvider() });

// HMAC of the RAW request body (GitHub / Shopify style): header `x-signature-256: sha256=<hex>`.
new WebhookTriggerAdapter({
  port: 8787,
  auth: { type: 'hmac', secret: process.env.WEBHOOK_SECRET ?? '' },
}).listen(agent, (input) => agent.send(input));

// Replay protection: the signed payload becomes `${timestamp}.${body}` and
// requests more than `toleranceSeconds` (default 300) old are rejected.
new WebhookTriggerAdapter({
  auth: {
    type: 'hmac',
    secret: process.env.WEBHOOK_SECRET ?? '',
    header: 'x-signature',
    timestampHeader: 'x-timestamp',
    toleranceSeconds: 120,
  },
});

// A shared bearer token (`Authorization: Bearer <token>`).
new WebhookTriggerAdapter({ auth: { type: 'bearer', token: process.env.WEBHOOK_TOKEN ?? '' } });

// Anything else: return true to accept. `rawBody` is a Buffer of the exact bytes received.
new WebhookTriggerAdapter({
  auth: { type: 'custom', verify: (req) => req.headers['x-api-key'] === process.env.API_KEY },
});
```

HMAC options: `header` (default `x-signature-256`), `algorithm` (`sha256` or
`sha1`, default `sha256`), `prefix` (default `sha256=`; `''` for a bare
digest), `timestampHeader` and `toleranceSeconds`. Signatures and bearer
tokens are compared in constant time. A request that fails authentication gets
a generic `401 {"error":"Unauthorized"}` - the response never says which check
failed - and the reason (never a secret or signature) is logged at `warn`
level. Serve webhooks over HTTPS (terminate TLS in front of the adapter) so
tokens and payloads are not sent in clear text.

### Slack request signatures

`SlackTriggerAdapter.handleRequest({ headers, rawBody })` handles a raw Slack
Events API request and returns the `{ status, body }` to send back. **Set
`signingSecret` for any endpoint reachable from outside your machine**: without
it, anyone who can reach the endpoint can run your agent, and `listen()` logs a
one-time warning through `options.logger`. With it, every request is verified
as [Slack documents](https://docs.slack.dev/authentication/verifying-requests-from-slack)
before the body is parsed: HMAC-SHA256 over `v0:{X-Slack-Request-Timestamp}:{raw body}`,
compared in constant time with `X-Slack-Signature` (`v0=<hex>`), and requests
more than five minutes old are rejected. Failures get a generic
`401 {"error":"Unauthorized"}`; the reason (never a secret or signature) is
logged at `warn` level. The signed `url_verification` handshake is answered
after verification.

```ts
import { createAgent, createMockProvider } from '@loushy/build-ai-agent';
import { SlackTriggerAdapter, verifySlackSignature } from '@loushy/build-ai-agent/triggers';
import * as http from 'node:http';

const agent = createAgent({ prompt: 'You are helpful.', provider: createMockProvider() });
const slack = new SlackTriggerAdapter({ signingSecret: process.env.SLACK_SIGNING_SECRET });
slack.listen(agent, (input) => agent.send(input));

http
  .createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      const { status, body } = await slack.handleRequest({ headers: req.headers, rawBody: Buffer.concat(chunks) });
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
  })
  .listen(3000);

// Your own handler (slash commands, interactivity)? Verify the RAW body yourself:
const authentic = verifySlackSignature({
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
  timestamp: '1700000000', // the X-Slack-Request-Timestamp header
  signature: 'v0=...', // the X-Slack-Signature header
  rawBody: '{"type":"url_verification"}',
});
```

`handleRequest` answers Slack after the agent finishes; Slack expects a reply
within three seconds, so for slow agents acknowledge first and run the agent in
the background.

### Cron schedules

`CronTriggerAdapter` takes either a fixed `intervalMs` or a real cron
expression:

```ts
import { createAgent, createMockProvider } from '@loushy/build-ai-agent';
import { CronTriggerAdapter } from '@loushy/build-ai-agent/triggers';

const agent = createAgent({ prompt: 'You are helpful.', provider: createMockProvider() });

new CronTriggerAdapter({
  cron: '*/15 9-17 * * MON-FRI', // minute hour day-of-month month day-of-week
  timezone: 'Europe/Paris', // IANA name; defaults to the machine's local zone
  input: 'Check the support queue',
  onResult: (result, error) => console.log(error ?? result?.text),
}).listen(agent, (input) => agent.send(input));
```

Supported syntax: `*`, lists (`1,15`), ranges (`1-5`), steps (`*/15`,
`10-40/10`), month names (`JAN`) and weekday names (`MON`), with `0` and `7`
both meaning Sunday, plus `@hourly`, `@daily`, `@weekly` and `@monthly`. As in
classic cron, when both day-of-month and day-of-week are restricted a day
matches if either does. An invalid expression throws a `CronExpressionError`
naming the field and showing a valid example. `parseCronExpression(expr,
timezone).nextRun(after)` is exported if you need the next fire time.

Around daylight-saving changes, a time that does not exist (spring forward) is
skipped for that day, and a time that happens twice (fall back) fires once;
an every-hour schedule keeps firing hourly. The timer is re-armed after each
run from the scheduled time (no drift, no double fire), and `stop()` clears it.

## Deployment

- `DeploymentAdapter`, `registerAdapter()`, `getAdapter()`, `listAdapters()` -
  the adapter registry behind `loushy build` (see [Deployment](./deployment.md)).
