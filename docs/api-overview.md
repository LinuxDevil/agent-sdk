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

## Flows, evals, observability and security

- `FlowBuilder` / `FlowExecutor` - multi-step workflow graphs.
- `defineEval()`, scorers such as `exactMatch` and `toolCallOrder`, and
  `llmJudge()` - agent evals run under vitest.
- `withSpan()` and `TraceExporter` - tracing for `AgentExecutor.execute()`.
- `NoopSandbox` / `SubprocessSandbox` - sandboxing for tools that opt in via
  `requiresSandbox`; guardrails such as `createCommandGuardrail()` and
  `secretScanGuardrail`.
- `EncryptionUtils`, `sha256`, `StorageService`, `renderTemplate`,
  `MemoryManager` - supporting utilities.

## Deployment

- `DeploymentAdapter`, `registerAdapter()`, `getAdapter()`, `listAdapters()` -
  the adapter registry behind `loushy build` (see [Deployment](./deployment.md)).
