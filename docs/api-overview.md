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
| `createAgent(config)`         | Zero-config `{ send(message) }` agent from a `model` string or provider (+ instructions, tools). |
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
