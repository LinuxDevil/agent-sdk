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
| `resumeAfterApproval()`       | Resume an execution paused for human approval. Advanced: see [the executor API](./executor-api.md). |
| `InMemoryApprovalStore`       | Process-local `ApprovalStore`; the default store of `createAgent()` agents. |
| `StorageServiceApprovalStore`, `LocalStorageCheckpointStore` (from `/utils`) | File-backed approval and checkpoint stores over a `StorageService` (see [Approvals](./approvals.md), [Durable execution](./durable-execution.md)). |
| `SqliteStore` (from `/sqlite`) | Sessions, checkpoints and approvals in one SQLite file (see [Sessions](./sessions.md#choosing-a-store)). |
| `fileStore(dir)`              | Sessions, checkpoints and approvals as plain JSON files under `dir` (see [Sessions](./sessions.md#choosing-a-store)). |
| `KVStore`, `KVCheckpointStore` (from `/kv`) | Stores on a Cloudflare Workers KV binding, for a hand-written Worker (see [Deployment](./deployment.md)). |
| `AgentStore`, `memoryStore()` | The `createAgent({ store })` option: `{ sessions?, checkpoints?, approvals?, tokens? }`, and an in-memory one (see [Sessions](./sessions.md#choosing-a-store); `tokens` holds OAuth tokens, see [OAuth](./oauth.md)). |
| `SessionAwaitingApprovalError` | Thrown by `execute()` when its `sessionId` is paused on an approval (see [Durable execution](./durable-execution.md)). |
| `SDKError`, `ERROR_CODES`    | Base class of the SDK's errors: a stable `code`, a `hint` and a `docs` link (see [Errors](./errors.md)). |
| `createDelegateTool()`        | Wrap a child agent as a tool for multi-agent delegation. Superseded by `subagents`. |

### Dynamic config

`createAgent()`'s `model`, `instructions` (or `prompt`) and `tools` each take
the static value or a function of the run, `(ctx) => value | Promise<value>`
(type `PerRun<T>`). `ctx` is `{ sessionId?, input, metadata?, principal? }` (type
`RunConfigContext`): the `sessionId` of `send()` / `stream()` or the
`agent.session()` id, the run's user input, the `metadata` call option of
`send()`, `stream()`, `session.send()` and `session.stream()`, and the caller
the run's auth accepted (`principal`, absent when the call did not pass one).
The functions
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
`AgentExecutor.execute()`: the lead gets a `task` tool to delegate, the three
background-task tools `agent_status`, `agent_await` and `agent_cancel`, and a
prompt listing,
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
`approvalStore` (e.g. `SqliteStore.approvals`) or a `store`; `approve: (request: PendingApproval) => boolean | string | Promise<boolean | string>`
decides each call in code without pausing (`stream()` still ends at the
pause) — `request` carries the call plus its `kind` and `principal`. With `askQuestion: true` the agent can ask the user a question
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

How a run ends (finish reasons), how to cancel one and how tool calls run in parallel: see [Runs](./runs.md).

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
| `createTodoTools({ store?, onChange? })`     | `todo_write` / `todo_read` tools (plus `getTodos()`) so agents can plan and track multi-step work; see [Todo tools](./tools.md#todo-tools). |
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

Todo tools and tool errors: see [Tools](./tools.md#todo-tools).

## Models, tokens and cost

Token estimates, the model price table, and the usage and cost of a run: see [Models, tokens and cost](./models-and-cost.md). Context compaction is on [its own page](./compaction.md).

## Flows, evals, observability and security

- `FlowBuilder` / `FlowExecutor` (`@lousho/build-ai-agent/flows`) - multi-step
  workflow graphs; see [Flows](./flows.md).
- `WebhookTriggerAdapter`, `SlackTriggerAdapter`, `CronTriggerAdapter` and `TriggerRegistry`
  (`@lousho/build-ai-agent/triggers`) - wake an agent from a webhook, a Slack
  message or a schedule; see [Triggers](./triggers.md).
- `jwt()`, `oidc()`, `basic()`, `apiToken()`, `anonymous()` and `routeAuth()`
  (`@lousho/build-ai-agent/auth`) - route auth as an ordered list; the caller
  it accepts reaches the run as `principal`; see [Route auth and principals](./auth.md).
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
- `EncryptionUtils`, `sha256`, `StorageService`
  (`@lousho/build-ai-agent/utils`) - supporting utilities; see
  [Utilities](./utilities.md).

## Deployment

- `DeploymentAdapter`, `registerAdapter()`, `getAdapter()`, `listAdapters()` -
  the adapter registry behind `lousho build` (see [Deployment](./deployment.md)).
