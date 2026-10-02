# API Overview

The package root (`@lousho/build-ai-agent`) exports everything below. For
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
│     @lousho/build-ai-agent          │
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
| `AgentBuilder`                | Fluent builder for an `AgentConfig` (`AgentBuilder.create().setName(...)...build()`). Advanced: see [the executor API](./executor-api.md). |
| `AgentExecutor.execute(opts)` | Static executor: runs an agent (LLM + tool-calling loop) and resolves to an `ExecutionResult`. Advanced: see [the executor API](./executor-api.md). |
| `AgentType`                   | Deprecated, no runtime effect: agents need no type.                        |
| `resumeAfterApproval()`       | Resume an execution paused for human approval. Advanced: see [the executor API](./executor-api.md). |
| `InMemoryApprovalStore`       | Process-local `ApprovalStore`; the default store of `createAgent()` agents. |
| `StorageServiceApprovalStore`, `LocalStorageCheckpointStore` | File-backed approval and checkpoint stores over a `StorageService` (see [Approvals](./approvals.md), [Durable execution](./durable-execution.md)). |
| `SqliteStore` (from `/sqlite`) | Sessions, checkpoints and approvals in one SQLite file (see [Sessions](./sessions.md#choosing-a-store)). |
| `AgentStore`, `memoryStore()` | The `createAgent({ store })` option: `{ sessions?, checkpoints?, approvals? }`, and an in-memory one (see [Sessions](./sessions.md#choosing-a-store)). |
| `SessionAwaitingApprovalError` | Thrown by `execute()` when its `sessionId` is paused on an approval (see [Durable execution](./durable-execution.md)). |
| `SDKError`, `ERROR_CODES`    | Base class of the SDK's errors: a stable `code`, a `hint` and a `docs` link (see [Errors](./errors.md)). |
| `createDelegateTool()`        | Wrap a child agent as a tool for multi-agent delegation. Superseded by `subagents`. |

### Dynamic config

`createAgent()`'s `model`, `instructions` (or `prompt`) and `tools` each take
the static value or a function of the run, `(ctx) => value | Promise<value>`
(type `PerRun<T>`). `ctx` is `{ sessionId?, input, metadata? }` (type
`RunConfigContext`): the `sessionId` of `send()` / `stream()` or the
`agent.session()` id, the run's user input, and the `metadata` call option of
`send()`, `stream()`, `session.send()` and `session.stream()`. The functions
run once when a run starts, before the first model call, and again on every
session turn. Everything else applies to what they return: `fallbackModels`
and `retry`, `projectInstructions`, memory, skills, sub-agents, MCP tools,
permissions, approvals and guardrails. A dynamic agent used as a sub-agent
resolves with the task prompt as `input`.

```ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const refund = defineTool({ name: 'refund', description: 'Refunds an order', input: z.object({ orderId: z.string() }), execute: async () => 'ok' });

const agent = createAgent({
  provider: mockModel(['Hello!']),
  // A cheaper model for short inputs, tenant instructions, tools by role.
  model: ({ input }) => (typeof input === 'string' && input.length < 200 ? 'small-model' : 'large-model'),
  instructions: ({ metadata }) => `You are the support agent of ${String(metadata?.tenant ?? 'Acme')}.`,
  tools: ({ metadata }) => (metadata?.role === 'admin' ? [refund] : []),
});

await agent.send('Hi', { metadata: { tenant: 'Globex', role: 'admin' } });
```

A function that throws fails the run with `LOUSHO_CONFIG_RESOLVER_FAILED`
(`error.field` names the option, `error.cause` is the thrown error): `send()`
rejects, `stream()` ends with an `error` event and a session keeps its
transcript as it was. A run paused for an approval or a question keeps the
`ctx` and the model it resolved in the paused snapshot: resuming it, even from
another process, uses that model (it never switches mid-turn) and calls the
`tools` function again with the same `ctx`. A run resumed from a crash
checkpoint (`agent.resume(id)`) resolves again with `input: []` and no
`metadata`. With only static values nothing changes: the agent is built once,
when it is created.

### UI bindings

`@lousho/build-ai-agent/react` exports `useLoushoAgent(source, options?)`, a
React hook that runs an agent in process (`{ agent, sessionId? }`) or over HTTP
(`{ url }`) and returns `messages`, `status`, `pendingApproval`,
`send()`, `stop()`, `approve()` and `reject()`. Its framework-neutral parts,
`reduceAgentEvents()` and `parseEventStream()`, are exported too. See
[React](./react.md). `@lousho/build-ai-agent/vue` exports the same
`useLoushoAgent()` as a Vue 3 composable, with the state as refs. See
[Vue](./vue.md). `@lousho/build-ai-agent/svelte` exports `loushoAgent()`, the
same state and actions as a Svelte store (`$agent`). See [Svelte](./svelte.md).

### Sub-agents

Pass `subagents: { researcher, writer }` (agents from `createAgent()` with a
`description`, or a `{ list, resolve }` catalog) to `createAgent()` or
`AgentExecutor.execute()`: the lead gets one `task` tool and a prompt listing,
each sub-agent runs on the task prompt alone, and it inherits the lead run's
signal, hooks (`ctx.subagent`), tracing, approval store and event listeners
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

### Memory

Pass `memory: [defineMemory({ name, scope, provider })]` to `createAgent()` to
keep items across conversations: each run recalls a slot's newest items into
the system prompt on its first model call, and the model gets
`remember_<name>` / `recall_<name>` tools. `scope` is `'global'`, `'session'`
or a function of `{ sessionId, metadata }`; `inMemoryMemory()` and
`fileMemory({ dir })` are the built-in providers. See [Memory](./memory.md).

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
import { createAgent, createMockProvider } from '@lousho/build-ai-agent';
const agent = createAgent({ prompt: 'You are helpful.', provider: createMockProvider() });
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000); // e.g. from a Stop button
const result = await agent.send('Write a long report', { signal: controller.signal });
console.log(result.finishReason); // 'aborted' if it was cancelled, else 'stop'
```

For a time limit, use `AbortSignal.timeout(ms)`:

```ts
import { createAgent, createMockProvider } from '@lousho/build-ai-agent';
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
  it is not retried by the provider retry and fallback wrappers and is not
  compacted into a provider error.
- The run's events end with `run.done` with `finishReason: 'aborted'`.
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
(cancelled with `signal`), `'max-steps'`, `'output-invalid'` (the reply
did not match the `output` schema even after the repair step, see
[Structured output](./structured-output.md)), `'budget-exceeded'` (a
`limits` budget such as `maxTokens` or `maxCostUsd` tripped; `result.budget`
says which, see [Budgets](./configuration.md#budgets)), or `'guardrail'` (an
input, output or tool guardrail blocked; `result.guardrail` says which, see
[Input and output guardrails](./guardrails.md#input-and-output-guardrails)). `'max-steps'` means the `maxSteps`
budget (default 10) ran out while the model still wanted to continue, so the
reply may be empty or partial; a run that finishes naturally within the budget
keeps its `'stop'`. Steps carried over by `initialSteps` or an approval resume
count against the budget, and `result.steps` is the number of steps taken. The
same reason is on the `finish` event and on `run.done` in
[streaming](streaming.md).

```ts
import { createAgent, createMockProvider } from '@lousho/build-ai-agent';
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
import { createAgent, createMockProvider, defineTool } from '@lousho/build-ai-agent';
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

Exported from `@lousho/build-ai-agent/testing` (see [Testing agents](testing.md)).

| Export                | Description                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `mockModel(script)`   | Scripted, deterministic `LLMProvider` that records every request (`calls`, `lastCall`, `reset()`, `assertExhausted()`). |
| `recordReplay(options)` | Record/replay VCR provider that serves model responses from a cassette. |

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
| `connectMcp(servers, options?)`             | Connect MCP servers from config (stdio or HTTP) and load their tools; see [Share servers with `connectMcp()`](./mcp.md#share-servers-with-connectmcp). |
| `loadMcpTools(client, connectionName)`       | Load a connected MCP server's tools as `ToolDescriptor`s. Available from the package root, `@lousho/build-ai-agent/tools`, and `@lousho/build-ai-agent/mcp`. |

See [Tools](./tools.md) for a guide to defining and registering tools.

```ts
import { defineTool } from '@lousho/build-ai-agent';
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
import { loadMcpTools } from '@lousho/build-ai-agent/mcp';

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
import { loadMcpTools, type SkippedMcpTool } from '@lousho/build-ai-agent/mcp';

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
import { createAgent, createTodoTools, type TodoStore } from '@lousho/build-ai-agent';

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
import { estimateTokens, estimateCost, getModelInfo, registerModel } from '@lousho/build-ai-agent';

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
import { createAgent, formatUsage } from '@lousho/build-ai-agent';

const result = await createAgent({ provider, instructions: 'You compare cities.' }).send('Compare 3 cities');

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
- `WebhookTriggerAdapter`, `SlackTriggerAdapter`, `CronTriggerAdapter` and `TriggerRegistry`
  (`@lousho/build-ai-agent/triggers`) - wake an agent from a webhook, a Slack
  message or a schedule; see [Triggers](./triggers.md).
- `defineEval()`, scorers such as `exactMatch`, `toolCallOrder` and `budget`, checks such
  as `includes` and `atLeast`, and `llmJudge()` - agent evals run under vitest
  or `lousho eval`; see [Evals](evals.md).
- `withSpan()` and `TraceExporter` - tracing for `AgentExecutor.execute()`.
  `TraceExporter` is a bring-your-own-exporter interface (no exporter
  ships by default); for real OpenTelemetry spans, import
  `createOtelTraceExporter()` from the `@lousho/build-ai-agent/otel`
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
  `GenerateHookContext` - hooks that observe, deny, rewrite or redact tool calls
  and model calls. See [Hooks](./hooks.md).
- `EncryptionUtils`, `sha256`, `StorageService` - supporting utilities; see
  [Utilities](./utilities.md).

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

## Deployment

- `DeploymentAdapter`, `registerAdapter()`, `getAdapter()`, `listAdapters()` -
  the adapter registry behind `lousho build` (see [Deployment](./deployment.md)).
