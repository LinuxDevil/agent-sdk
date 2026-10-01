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

## Tools

| Export                                       | Description                                   |
| -------------------------------------------- | --------------------------------------------- |
| `ToolRegistry`                               | Holds the tools an agent config refers to.    |
| `httpTool`, `currentDateTool`, `dayNameTool` | Built-in tools.                               |
| `loadMcpTools(client, connectionName)`       | Load a connected MCP server's tools as `ToolDescriptor`s. Available from the package root, `@loushy/build-ai-agent/tools`, and `@loushy/build-ai-agent/mcp`. |

```ts
import { loadMcpTools } from '@loushy/build-ai-agent/mcp';

const tools = await loadMcpTools(mcpClient, 'my-server');
```

### Argument validation

Before a tool runs, the model's arguments are parsed with the tool's zod
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

## Deployment

- `DeploymentAdapter`, `registerAdapter()`, `getAdapter()`, `listAdapters()` -
  the adapter registry behind `loushy build` (see [Deployment](./deployment.md)).
