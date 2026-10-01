# API Overview

The package root (`@loushy/build-ai-agent`) exports everything below. For
the complete, generated API reference (every export, signature and doc
comment), build the TypeDoc site:

```bash
npm run docs:build   # writes docs/api/index.html
```

## Building and running agents

| Export                        | Description                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- |
| `createAgent(config)`         | Zero-config `{ send(message) }` agent from a prompt + provider (+ tools).   |
| `AgentBuilder`                | Fluent builder for an `AgentConfig` (`AgentBuilder.create().setName(...)...build()`). |
| `AgentExecutor.execute(opts)` | Static executor: runs an agent (LLM + tool-calling loop) and resolves to an `ExecutionResult`. |
| `AgentType`                   | Agent type enum (e.g. `AgentType.SmartAssistant`).                          |
| `resumeAfterApproval()`       | Resume an execution paused for human approval.                             |
| `createDelegateTool()`        | Wrap a child agent as a tool for multi-agent delegation.                    |

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
  `execute()` again with the same `sessionId` resumes where the run stopped.
  Tool calls the run never reached get an `{ error }` result saying they were
  cancelled, so the conversation stays valid for the provider.
- An already-aborted signal returns at once without calling the provider.

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
| `loadMcpTools(client, connectionName)`       | Load a connected MCP server's tools as `ToolDescriptor`s. Available from the package root, `@loushy/build-ai-agent/tools`, and `@loushy/build-ai-agent/mcp`. |

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

```ts
import { loadMcpTools } from '@loushy/build-ai-agent/mcp';

const tools = await loadMcpTools(mcpClient, 'my-server');
```

### Tool errors

A tool call can fail in two ways. In both, the run continues and the model
receives a structured JSON error as the tool result (never the string `null`),
so it can recover. `tool-result` events, tracing, `onToolResult` and
`postToolCall` hooks see the call as an error.

**Argument validation.** Before a tool runs, the model's arguments are parsed with the tool's zod
`parameters` schema. Validation happens first, so pre-tool hooks, the
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
{ "error": "TypeError", "toolName": "search", "message": "query must not be empty" }
```

Errors extending `PropagatingToolError` (for example the delegation depth
guard) are the exception: they are rethrown and abort the run instead of being
shown to the model.

## Flows, evals, observability and security

- `FlowBuilder` / `FlowExecutor` - multi-step workflow graphs.
- `defineEval()`, scorers such as `exactMatch` and `toolCallOrder`, and
  `llmJudge()` - agent evals run under vitest.
- `withSpan()` and `TraceExporter` - tracing for `AgentExecutor.execute()`.
  `TraceExporter` is a bring-your-own-exporter interface (no exporter
  ships by default); for real OpenTelemetry spans, import
  `createOtelTraceExporter()` from the `@loushy/build-ai-agent/otel`
  subpath (requires the optional peer dependency `@opentelemetry/api`)
  instead of hand-rolling the OTel bridge - see
  `examples/tracing/run-otel.ts`.
- `NoopSandbox` / `SubprocessSandbox` - sandboxing for tools that opt in via
  `requiresSandbox`; guardrails such as `createCommandGuardrail()` and
  `secretScanGuardrail`.
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
  `MemoryManager` - supporting utilities.

### Flow expressions

`oneOf` branch conditions (and the Agent Forge router node's branch conditions)
and `evaluator` node expressions are evaluated by a small built-in expression
evaluator. It never compiles or runs host code: there is no `eval`,
`new Function` or `vm` in `src/flows`. Before evaluation, `{{name}}` placeholders
are replaced with the variable's text (so quote string placeholders:
`'{{classify}}' === 'refund'`). The expression is then evaluated against the
flow's variables.

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
  the adapter registry behind `loushy build` (see [Deployment](./deployment.md)).
