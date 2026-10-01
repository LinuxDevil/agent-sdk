# Configuration

## Agent spec files (`AgentSpec`)

A declarative agent is a YAML (`.yaml`/`.yml`) or JSON (`.json`) file,
validated with zod by `loadSpec()` (`src/spec/schema.ts`). It is the format
`loushy dev` serves and `loushy build` deploys.

| Field            | Type       | Required | Description                                             |
| ---------------- | ---------- | -------- | ------------------------------------------------------- |
| `name`           | `string`   | yes      | Agent name.                                             |
| `prompt`         | `string`   | yes      | System prompt.                                          |
| `provider.type`  | `string`   | yes      | `openai`, `anthropic`, `ollama`, `openrouter` or `mock`. |
| `provider.model` | `string`   | yes      | Model id every call uses (the provider's configured model; an agent's own `settings.model` would override it). |
| `tools`          | `string[]` | no       | Built-in tool names (see below).                       |

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

### MCP (Model Context Protocol) tools

Tools advertised by a remote MCP server aren't referenced by name in a spec
file - connect a `Client` from `@modelcontextprotocol/sdk` yourself and load
its tools with `loadMcpTools()`, then pass the result to `createAgent()` (or
register it on a `ToolRegistry`):

```ts
import { loadMcpTools } from '@loushy/build-ai-agent/mcp';

const tools = await loadMcpTools(mcpClient, 'my-server');
const agent = createAgent({ prompt: '...', provider, tools });
```

`loadMcpTools` is also available from the package root and from
`@loushy/build-ai-agent/tools`.

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

## `createAgent()` options

| Option     | Description                                                        |
| ---------- | ------------------------------------------------------------------ |
| `prompt`   | System prompt (required).                                          |
| `provider` | An `LLMProvider` instance (required).                              |
| `tools`    | `Record<string, ToolDescriptor>`, keyed by the name the agent uses. |
| `name`     | Agent name (default `'agent'`).                                    |
| `maxSteps` | Passed through to `AgentExecutor.execute()`.                        |

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
| `temperature`, `maxTokens`              | Generation parameters.                                          |
| `onEvent`                               | Callback for execution events (`start`, `tool-call`, `finish`, ...). |
| `approvalStore`, `sessionId`            | Human-in-the-loop approvals (see `resumeAfterApproval()`).       |
| `checkpointStore`                       | Persist/resume execution checkpoints.                           |
| `exporter`                              | A `TraceExporter` for tracing spans.                            |
| `onLLMRequest`, `onLLMResponse`, `onToolCall`, `onToolResult` | Observability hooks.                |

It resolves to an `ExecutionResult`: `{ text, messages, toolCalls, usage,
finishReason, steps, approvalId? }`.

## CLI

### `loushy dev <spec> [--port N] [--host H]`

Local dev server for a spec file: `GET /` chat UI, `GET /health`,
`POST /chat` (`{ "message": "..." }`, 1MB body limit). Reloads the agent
whenever the spec file changes and keeps the last good config if an edit is
invalid.

- `--port` - default `3737`.
- `--host` - default `127.0.0.1` (localhost only). Pass e.g. `--host=0.0.0.0`
  to opt in to LAN access.

### `loushy build --target=<target> --agent=<spec> [--out=<dir>]`

Builds a deployable artifact; see [Deployment](./deployment.md).
`--out` defaults to `.loushy/build/<target>`.
