# Tools

A tool is a typed function the model can call. Define one with `defineTool()`:
the argument and result types are inferred from its zod `input`, the arguments
are validated before `execute` runs, and the result drops in anywhere tools are
accepted (`createAgent({ tools: [...] })`, `ToolRegistry.register(tool)`,
`AgentBuilder.addTool(tool)`).

```ts
import { defineTool, createAgent, type ToolInput, type ToolOutput } from '@loushy/build-ai-agent';
import { z } from 'zod';

const weather = defineTool({
  name: 'weather', // 1-64 chars: letters, digits, _ and -
  description: 'Get weather information',
  input: z.object({ location: z.string(), units: z.enum(['celsius', 'fahrenheit']) }),
  execute: async ({ location, units }) => ({ temperature: 72, conditions: 'sunny' }),
});

type WeatherArgs = ToolInput<typeof weather>;   // { location: string; units: 'celsius' | 'fahrenheit' }
type WeatherResult = ToolOutput<typeof weather>; // { temperature: number; conditions: string }

const agent = createAgent({ prompt: '...', provider, tools: [weather] });
```

## `defineTool()` options

| Option | Required | Description |
| ------ | -------- | ----------- |
| `name` | yes | What the model calls the tool by. Must match `^[a-zA-Z0-9_-]{1,64}$` (the limit LLM providers put on function names). |
| `description` | yes | What the tool does. The model reads it to decide when to call the tool. |
| `input` | yes | Zod schema of the arguments. `execute`, `needsApproval` and `sandboxExecute` receive its parsed (output) type. |
| `execute(args, ctx)` | yes | Runs the tool. `ctx` carries the call's `toolCallId` and `abortSignal`. The return type is kept on the tool (`ToolOutput`). |
| `displayName` | no | Label for UIs. Defaults to `name`. |
| `needsApproval` | no | `true`, or a predicate typed from `input`, to pause for a human decision before the call runs. See [Approvals](./approvals.md). |
| `requiresSandbox` | no | Run the tool through the configured `SandboxAdapter` instead of in-process (needs `sandboxExecute`). See [Guardrails and sandboxing](./guardrails.md#sandboxed-tools). |
| `sandboxExecute(args, sandbox)` | no | The sandboxed execution path used when `requiresSandbox` is true. |

`defineTool()` checks the name, the description and the zod `input` when it is
called, and throws an error that says how to fix a bad value. Registering two
tools with the same name throws an error naming the conflict.

A defined tool is a regular `ToolDescriptor`: it carries its schema as
`inputSchema` (the same schema as `input`) and its `execute` function directly.
The `.tool` field (an `ai` v4 `{ description, parameters, execute }` object) is
legacy: it is still built for compatibility, and only used for hand-written
descriptors that set neither `inputSchema` nor `execute`.

## What happens when the model calls a tool

- **Validation first.** The model's arguments are parsed with `inputSchema`
  (defaults, coercions and transforms applied) before hooks, `needsApproval`
  and `execute` see them. Arguments that do not match never reach `execute`:
  the model gets a structured `ToolArgumentsValidationError` result and can
  retry.
- **Errors are results.** A tool that throws gives the model
  `{ error, toolName, message, kind }` (no stack trace) and the run continues.
  See [Errors](#errors).
- **Parallel calls.** Several calls in one model turn run concurrently; cap
  them with `toolConcurrency` (`1` for strictly sequential). Results reach the
  transcript in the model's call order. See
  [Parallel tool calls](./api-overview.md#parallel-tool-calls).
- **Cancellation.** A run's `AbortSignal` reaches each call as
  `ctx.abortSignal`, so long-running work can stop early.
- **Retries after a crash.** With durable execution a tool can run more than
  once across a crash; use `ctx.toolCallId` as an idempotency key. See
  [Durable execution](./durable-execution.md#at-least-once-tools-make-side-effects-idempotent).

## Execute context

`execute(args, ctx)` always gets a real second argument, typed
`ToolExecutionContext` (exported from the package root; it replaces the `ai`
SDK's `ToolExecutionOptions`), on every path that
runs a tool: the main loop, the call that runs after an approval, tools that
run in a sandbox (`sandboxExecute(args, sandbox, ctx)`) and a flow's tool-call
node.

| Field | Value |
| --- | --- |
| `ctx.toolCallId` | The model's id for this call. It stays the same when the call is re-run after a crash. A call with no model turn behind it (a flow node) gets a generated id. |
| `ctx.messages` | A read-only copy of the transcript the model had seen before it made the call: no system prompt and not the assistant turn that made the call. Empty for a flow node. |
| `ctx.abortSignal` | The run's `AbortSignal`, set when the run has one. |
| `ctx.sessionId` | Reserved: the type has it and `buildToolRunContext()` passes it through, but the executor does not set it yet. |

A `sandboxExecute(args, sandbox)` that ignores the third argument keeps working.

## Errors

Every way a tool call can fail reaches the model as the same result, so one
check works everywhere (including the call that runs after an approval):

```json
{ "error": "TypeError", "toolName": "search", "message": "query must not be empty", "kind": "execution" }
```

- `error`: the error's name (`TypeError`, `ToolArgumentsValidationError`, ...), or the kind's default name for a failure that is not a thrown error.
- `toolName` and `message`: the message only, never a stack, capped at 2,000 characters (`... (truncated)` marks a cut).
- `kind`: why the call failed.
- Some kinds add fields: `issues` for `validation`, `note` for `rejected`, `reason` for `denied`.

The transcript message carries `isError: true`; `tool-result` events, `onToolResult`, `postToolCall` hooks and `tool.error` events see the call as failed.

| `kind` | `error` | When |
| ------ | ------- | ---- |
| `execution` | the thrown error's name | `execute` (or `needsApproval`) threw. |
| `validation` | `ToolArgumentsValidationError` | The arguments did not match `inputSchema`; `execute` did not run. Adds `issues`. |
| `not-found` | `ToolNotFoundError` | The model called a tool the registry does not have (or the run has no registry). |
| `rejected` | `ToolRejectedError` | A reviewer rejected the call at an approval. Adds `note` when given. |
| `not-run` | `ToolNotRunError` | The call was never started (a resumed run whose approval was saved without its remaining calls). |
| `mcp` | `McpToolError` | An MCP server answered `isError: true`; `message` is the server's text. |
| `sandbox` | `SandboxRequiredError` | The tool has `requiresSandbox` but no `sandboxExecute`, so it was refused rather than run unsandboxed. |
| `denied` | `ToolDeniedError` | A `deny` [permission rule](./approvals.md#permission-policies) refused the call; `execute` did not run. Adds `reason` when the rule has one. |

`toolErrorResult({ toolName, error, kind?, toolCallId?, details? })` builds this
result; use it in your own tool wrappers so they match. A thrown error can pick
its kind by carrying a `toolErrorKind` property. An error extending
`PropagatingToolError` is not a result: it aborts the run.

## Built-in tools

| Export | Tool |
| ------ | ---- |
| `httpTool`, `createHttpTool(options)` | HTTP requests, with SSRF protection (every resolved address is checked before connecting). |
| `currentDateTool`, `dayNameTool` | Current date/time (ISO, UTC) and day of the week. |
| `createTodoTools()` | `todo_write` / `todo_read` so an agent can plan multi-step work; see [Todo tools](./api-overview.md#todo-tools). |
| `createFsTools()`, `createShellTool()` | File system and shell tools for coding agents; see [Workspace tools](./workspace-tools.md). |
| `createEmailTool()`, `createSlackTool()`, `createGitHubTools()`, `createJiraTools()` | Integrations that need credentials, so they are built with options. |
| `createAgent({ mcpServers })`, `connectMcp(servers)` | Every tool of MCP servers given as config (stdio `command` or HTTP `url`), named `<server>__<tool>`; see [Connect MCP servers](./configuration.md#connect-mcp-servers-mcpservers-connectmcp). |
| `loadMcpTools(client, name)` | Every tool of a connected MCP server; see [MCP tools](./configuration.md#mcp-model-context-protocol-tools). |

Built-in descriptors are passed keyed by the name the agent uses:
`createAgent({ tools: { current_date: currentDateTool } })`. Spec files refer to
`http`, `current-date` and `day-name` by name (see
[Configuration](./configuration.md#tools-a-spec-can-reference)).

## `ToolRegistry`

`createAgent()` builds a registry for you. With `AgentBuilder` +
`AgentExecutor.execute()`, or to share tools between agents, fill one yourself:
`register(tool)` for a `defineTool()` result, `register(name, descriptor)` for a
raw `ToolDescriptor` (a built-in tool, an MCP tool, or an existing `tool()` from
the `ai` SDK), and `registerMany()` for a record of descriptors or an array of defined tools.

```ts
import { ToolRegistry, currentDateTool, defineTool } from '@loushy/build-ai-agent';
import { z } from 'zod';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order',
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({ orderId, status: 'shipped' }),
});

const tools = new ToolRegistry();
tools.register(lookupOrder);
tools.register('current_date', currentDateTool);
```

Pass it as `toolRegistry` to `AgentExecutor.execute()`; the agent config's
`tools` map names the tools it may use.
