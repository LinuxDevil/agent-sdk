# Tools

A tool is a typed function the model can call. Define one with `defineTool()`:
the argument and result types are inferred from its zod `input`, the arguments
are validated before `execute` runs, and the result drops in anywhere tools are
accepted (`createAgent({ tools: [...] })`, `ToolRegistry.register(tool)`,
`AgentBuilder.addTool(tool)`).

```ts
import { defineTool, createAgent, type ToolInput, type ToolOutput } from '@lousho/build-ai-agent';
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

Tools the model provider runs itself (web search, code interpreter, file search) go in the same `tools` list; see [Hosted provider tools](./hosted-tools.md).

With many tools, mark them `deferLoading` so the model finds them with a built-in `tool_search` tool instead of receiving every definition on every call; see [Tool search](./tool-search.md).

## `defineTool()` options

| Option | Required | Description |
| ------ | -------- | ----------- |
| `name` | yes | What the model calls the tool by. Must match `^[a-zA-Z0-9_-]{1,64}$` (the limit LLM providers put on function names). |
| `description` | yes | What the tool does. The model reads it to decide when to call the tool. |
| `input` | yes | Zod schema of the arguments (zod 3 or zod 4, or another Standard Schema that exposes `~standard.jsonSchema`). `execute`, `needsApproval` and `sandboxExecute` receive its parsed (output) type. |
| `execute(args, ctx)` | yes | Runs the tool. `ctx` carries the call's `toolCallId` and `abortSignal`. The return type is kept on the tool (`ToolOutput`). |
| `displayName` | no | Label for UIs. Defaults to `name`. |
| `needsApproval` | no | `true`, or a predicate typed from `input`, to pause for a human decision before the call runs. See [Approvals](./approvals.md). |
| `annotations` | no | MCP hints (`readOnlyHint`, `destructiveHint`, ...), stored as `metadata.mcp.annotations`. `readOnlyHint: true` lets the tool run in [plan mode](./permission-modes.md#which-tools-are-read-only). |
| `deferLoading` | no | Withhold the tool's definition from the model until it finds the tool with `tool_search`. See [Tool search](./tool-search.md). |
| `editsFiles` | no | The tool edits files: [`permissionMode: 'acceptEdits'`](./permission-modes.md#file-edits-the-editsfiles-marker) runs its calls without asking. Stored as `metadata.editsFiles`. |
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
  [Parallel tool calls](./runs.md#parallel-tool-calls).
- **Cancellation.** A run's `AbortSignal` reaches each call as
  `ctx.abortSignal`, so long-running work can stop early.
- **Progress.** An `execute` written as `async function*` streams snapshots
  of its output while it runs; the last one is the result. See
  [Streaming partial results](#streaming-partial-results).
- **Many calls in one step.** With `createAgent({ codeMode })` the model can
  also call tools from a short JavaScript program (`run_code`), each call going
  through the same checks. See [Code mode](./code-mode.md).
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
| `ctx.sessionId` | The run's session id — `agent.session({ id })`'s id or `send()`'s / `AgentExecutor.execute()`'s `sessionId`; absent when the run has none. |
| `ctx.principal` | Who the run acts for (route auth's caller, a channel's sender), frozen; absent without one. See [Principals in tools and approvals](./auth.md#principals-in-tools-and-approvals). |
| `ctx.approval` | Set when the call runs because a human approved it: the decision's `note`, and `by`, who decided, when the decision named them. |

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

**Argument validation.** The model's arguments are parsed with the tool's zod
`inputSchema` (for a legacy descriptor, `tool.parameters`) before the tool runs, so pre-tool hooks, the
`needsApproval` predicate and `execute` all receive the **parsed** value. Tools without a zod schema are
passed through unchanged. If the arguments do not match, `execute` is not called and `preToolCall` hooks are
skipped, because there is no valid call. The model gets a `validation` result it can retry from:

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

`ToolArgumentsValidationError` (with a typed `issues` array) is exported from the package root.

`toolErrorResult({ toolName, error, kind?, toolCallId?, details? })` builds this
result; use it in your own tool wrappers so they match. A thrown error can pick
its kind by carrying a `toolErrorKind` property. An error extending
`PropagatingToolError` is not a result: it aborts the run.

## Built-in tools

| Export | Tool |
| ------ | ---- |
| `httpTool`, `createHttpTool(options)` | `http_request`: HTTP requests (any method, headers, body), with SSRF protection: loopback, private and link-local destinations are refused on every hop, and the connection goes to the address that was checked. Node only. |
| `webFetchTool`, `createWebFetchTool(options)` | `web_fetch`: `GET` one public web page and return it as text, with the same SSRF protection and caps on redirects, size and time. Node only; see below. |
| `currentDateTool`, `dayNameTool` | Current date/time (ISO, UTC) and day of the week. |
| `createTodoTools()` | `todo_write` / `todo_read` so an agent can plan multi-step work; see [Todo tools](#todo-tools). |
| `askQuestionTool()`, `createAgent({ askQuestion: true })` | `ask_question`: the agent asks the user something and the run pauses until `agent.approvals.answer()`; see [Asking the user a question](./approvals.md#asking-the-user-a-question). |
| `createFsTools()`, `createShellTool()` | File system and shell tools for coding agents; see [Workspace tools](./workspace-tools.md). |
| `createEmailTool()`, `createSlackTool()`, `createGitHubTools()`, `createJiraTools()` | Integrations that need credentials, so they are built with options. |
| `createAgent({ mcpServers })`, `connectMcp(servers)` | Every tool of MCP servers given as config (stdio `command` or HTTP `url`), named `<server>__<tool>`; see [Use MCP servers in an agent](./mcp.md#use-mcp-servers-in-an-agent). |
| `openApiTools(document, options)` | One tool per operation of an OpenAPI 3.0 / 3.1 document; mutating operations ask for approval. See [OpenAPI tools](./openapi-tools.md). |
| `loadMcpTools(client, name)` | Every tool of a connected MCP server; see [MCP tools](./mcp.md#tools-from-a-client-you-connected-yourself). |

Built-in descriptors are passed keyed by the name the agent uses:
`createAgent({ tools: { current_date: currentDateTool } })`. Spec files refer to
`http`, `web-fetch`, `current-date` and `day-name` by name (see
[Configuration](./configuration.md#tools-a-spec-can-reference)).

How `http_request` and `web_fetch` refuse private destinations: an IP-literal
host is checked before the request; a host name is resolved once, when the
connection is opened, every address it resolves to is checked (loopback,
RFC 1918, link-local including the cloud metadata address, CGNAT, multicast
and reserved ranges, IPv4-mapped IPv6, NAT64 and 6to4), and the socket
connects to the address that was checked. Redirects are followed by hand and
each hop is checked the same way. A DNS-rebinding name, one that answers a
public address first and a private one later, has no second lookup to answer.
When `http_request` runs through a sandbox, the host is resolved and checked
in the agent's process and the sandboxed process connects to that address.
Both tools take `allowPrivate` (host patterns such as `intranet.example` or
`*.corp.example`) for hosts that may resolve to private addresses.

`web_fetch` takes `{ url }` (`http:` or `https:`, no `user:password@`) and
returns `{ url, finalUrl, status, contentType, content, truncated }`. It only
sends `GET`, with no body, cookies or caller-chosen headers. HTML becomes
plain text (scripts, styles and similar removed, block elements on their own
lines, link URLs in parentheses, entities decoded); JSON and `text/*` are
returned as sent; other types (images, PDFs, binaries) return a note instead
of content. A 4xx or 5xx response is returned with its body, not thrown, so
the model can read an error page. Refusals, timeouts, too many redirects and
bad URLs are tool errors that name the host. The page is untrusted input: the
tool's description tells the model so, and `readOnlyHint` and `openWorldHint`
are set. Options of `createWebFetchTool()` (the `vendor/` model prefix chooses
the provider; with OpenRouter use `openrouter/<vendor>/<model>`, e.g.
`openrouter/openai/gpt-4o-mini`):

```ts
import { createAgent, createWebFetchTool } from '@lousho/build-ai-agent';

const webFetch = createWebFetchTool({
  timeoutMs: 30_000, // whole request: redirects and body included
  maxRedirects: 10, // each hop is checked again
  maxBytes: 2 * 1024 * 1024, // read from the network, then stop (truncated: true)
  maxChars: 50_000, // characters of text returned to the model
  allowedHosts: ['*.example.com', 'example.com'], // `*.` matches subdomains only, so list the bare host too; when set, any other host is refused before DNS
  blockedHosts: ['private.example.com'], // always refused, before DNS
  allowPrivate: [], // hosts allowed to resolve to private addresses
  userAgent: 'lousho-web-fetch',
});

const agent = createAgent({ model: 'openai/gpt-4o-mini', tools: [webFetch] });
```

Each `createWebFetchTool()` has its own connection pool, kept for as long as
the tool exists and released with it by garbage collection (there is no close
method). `web_fetch` does not exist in the Cloudflare Worker build, and the
Worker's `http_request` is a different tool that reaches only the host names
listed in its `LOUSHO_HTTP_ALLOW` binding; see
[Cloudflare Workers](./cloudflare-workers.md#providers-and-tools).

## Todo tools

`createTodoTools(options?)` gives long-running agents a plan to track:
`todo_write` replaces the whole list (`{ id?, content, status }` items, status
`pending` | `in_progress` | `completed`, at most one `in_progress`) and returns
the list plus counts; `todo_read` returns it. Ids are assigned automatically and
stay stable when a later write repeats an item's content. Invalid lists (for
example two `in_progress`) reach the model as a structured tool error so it can
retry. The list lives in memory per call; pass `store` (`{ get, set }`) to
persist it, and `onChange` to update a UI. Every successful `todo_write` also
emits a `todo.updated` stream event with the new list and its counts (see
[Stream events](./stream-events.md)), which the [React](./react.md#todos),
[Vue](./vue.md#todos) and [Svelte](./svelte.md#todos) bindings turn into
`useTodos()` / `loushoTodos()`, so a UI shows the plan live without `onChange`.

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

## Advanced: `ToolRegistry`

`createAgent()` builds a registry for you; fill one yourself only with
`AgentExecutor.execute()` (see [the executor API](./executor-api.md)) or to
share tools between agents:
`register(tool)` for a `defineTool()` result, `register(name, descriptor)` for a
raw `ToolDescriptor` (a built-in tool, an MCP tool, or an existing `tool()` from
the `ai` SDK), and `registerMany()` for a record of descriptors or an array of defined tools.

```ts
import { ToolRegistry, currentDateTool, defineTool } from '@lousho/build-ai-agent';
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

## Streaming partial results

A long tool (a report builder, a search over many sources) can show progress
while it runs: write `execute` as an `async function*`. Every `yield` is a
complete snapshot of the output so far, which replaces the previous one, and
reaches the run's events as `tool.partial` (see
[Stream events](./stream-events.md)). The last yielded value is the tool's
result: the model gets it, and it is the `result` of the call's `tool.done`, so
the final snapshot appears twice (as the last `tool.partial` and in
`tool.done`). A `return` value is ignored; a generator that yields nothing has
the result `null`, as does any tool that returns `undefined`: the transcript, the
model and `tool.done` all see `null`.

```ts
import { createAgent, defineTool, type ToolOutput } from '@lousho/build-ai-agent';
import { z } from 'zod';

const buildReport = defineTool({
  name: 'build_report',
  description: 'Builds a report from several sources',
  input: z.object({ topic: z.string() }),
  async *execute({ topic }, ctx) {
    const sections: string[] = [];
    for (const source of ['news', 'papers', 'forums']) {
      if (ctx.abortSignal?.aborted) return;
      sections.push(`${source}: notes on ${topic}`);
      yield { topic, sections: [...sections], done: false };
    }
    yield { topic, sections, done: true };
  },
});
type Report = ToolOutput<typeof buildReport>; // { topic: string; sections: string[]; done: boolean }

const agent = createAgent({ model: 'openai/gpt-4o-mini', tools: [buildReport] });
for await (const event of agent.stream('Write a report on solar power.')) {
  if (event.type === 'tool.partial') console.log(`step ${event.index}`, event.output);
}
```

What to know:

- **Only the result is kept.** Snapshots are not sent to the model, not added
  to the transcript or the session, not checkpointed and not recorded in trace
  spans. Hooks (`postToolCall`, `onToolResult`) see only the result.
- **A crash loses them.** Partial output is not durable: after a crash the
  call has no result yet and runs again from the start (a new `tool.start`,
  `index` from 0). A pause for a [sign-in](./oauth.md) inside the generator
  re-runs it from the start too, but the continued run reports `tool.resume`
  rather than a second `tool.start`, again with `index` from 0. Snapshots
  already streamed stay in the event log; a UI should drop them when the call
  pauses or starts again (the [UI bindings](./react.md) do).
- **Approvals and permissions apply first.** A generator tool that needs
  approval runs, and streams, only after the decision (also on a streamed
  resume, `agent.approvals.streamResolve()`).
- **Cancellation.** When the run is aborted, the SDK stops reading the
  generator at once, settles the call as aborted and calls its `return()`, so
  its `finally` blocks run - once the `await` it is in settles, so pass
  `ctx.abortSignal` to the work you await.
- **Tokens are redacted in snapshots too.** A snapshot that contains a token
  the tool got from `ctx.getToken()` has it replaced with `[REDACTED]`, like the
  result. A `postToolCall` hook that rewrites the result does not see the
  snapshots: if a tool's output must be filtered by a hook, filter it in the
  tool or do not stream it.
- **Which values stream.** Only a value with a `next()` method that is also
  async iterable (what an `async function*` returns) is streamed. A result that
  is only async iterable, such as a `ReadableStream`, is an ordinary result.
- **The whole run counts.** `toolConcurrency` holds the slot until the
  generator ends. Calling the tool's `execute` yourself returns the generator.
- **Where.** The main loop, the call that runs after an approval, and a flow's
  tool-call node (which keeps only the result) all iterate the generator; a
  tool's `sandboxExecute` does not stream. In the AI SDK UI stream, snapshots
  are preliminary tool outputs (see [AI SDK UI](./ai-sdk-ui.md#event-mapping)).
