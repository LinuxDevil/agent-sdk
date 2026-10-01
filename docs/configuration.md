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
import { createAgent } from '@loushy/build-ai-agent';
import { loadMcpTools } from '@loushy/build-ai-agent/mcp';

const tools = await loadMcpTools(mcpClient, 'my-server');
const agent = createAgent({ prompt: '...', provider, tools });
```

`loadMcpTools` is also available from the package root and from
`@loushy/build-ai-agent/tools`.

### Serve an agent over MCP

`serveMcp()` is the reverse of `loadMcpTools()`: it exposes an agent (and,
optionally, some of its tools) as an MCP server, so Claude Code, Cursor and
other MCP clients can call it.

```ts
import { createAgent, defineTool } from '@loushy/build-ai-agent';
import { serveMcp } from '@loushy/build-ai-agent/mcp';
import { z } from 'zod';

const searchDocs = defineTool({
  name: 'search_docs',
  description: 'Search the docs',
  input: z.object({ query: z.string() }),
  execute: ({ query }) => `results for ${query}`,
});

const supportAgent = createAgent({ prompt: 'You answer support questions.', provider, tools: [searchDocs] });

const server = await serveMcp({
  agent: supportAgent,            // exposed as ONE tool taking { message: string }
  name: 'support-bot',            // server name; the tool name defaults to a sanitized version
  description: 'Ask the support agent a question',
  tools: [searchDocs],            // optional: also expose these tools directly
  transport: { type: 'http', port: 3920, host: '127.0.0.1', path: '/mcp' }, // default: 'stdio'
});
await server.close();
```

- **Stateless.** Every call to the agent tool is a fresh conversation.
- **Cancellation.** Cancelling the MCP request aborts the agent run
  (`agent.send(message, { signal })`).
- **Errors.** An agent failure comes back as an MCP result with `isError: true`.
- **Approvals.** Approval-gated tools cannot be approved over MCP. A run that
  pauses for approval returns `isError: true` with a message saying so. Tools
  flagged `needsApproval` are not exposed directly unless you pass
  `allowApprovalTools: true`; if you do, clients run them with **no human gate**.
- **stdio.** Nothing but the MCP protocol is written to stdout; warnings go to stderr.
- **HTTP.** Binds `127.0.0.1` by default. Add `auth: { type: 'bearer', token }`
  to require an `Authorization: Bearer` header; binding a non-loopback host
  without `auth` logs a warning.

From the command line, `loushy mcp` serves an agent spec file (stdio by default):

```sh
npx loushy mcp agent.yaml
npx loushy mcp agent.yaml --http --port 3920 --host 127.0.0.1
```

To use it from an MCP client, add it to the client's MCP config (for example
`.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "support-bot": { "command": "npx", "args": ["loushy", "mcp", "agent.yaml"] }
  }
}
```

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

| Option         | Description                                                    |
| -------------- | -------------------------------------------------------------- |
| `model`        | A `'provider/model'` string such as `'openai/gpt-4o-mini'`, resolved with `resolveProvider()` (key from the env var above). Alternative to `provider`. |
| `provider`     | An `LLMProvider` instance (real or mock). Alternative to `model`. If you pass both, `provider` is used and `model` becomes the agent's per-run model setting (a bare model id such as `'gpt-4o'`). |
| `instructions` | System prompt. Optional (defaults to `'You are a helpful assistant.'`). |
| `prompt`       | Working alias of `instructions`; passing both is an error.      |
| `tools`    | `Record<string, ToolDescriptor>`, keyed by the name the agent uses. |
| `name`     | Agent name (default `'agent'`).                                    |
| `maxSteps` | Passed through to `AgentExecutor.execute()`.                        |
| `projectInstructions` | `true` or `{ cwd?, files? }`: append the nearest `AGENTS.md` / `CLAUDE.md` to the instructions (off by default; see [Project instructions](#project-instructions)). |

With neither `model` nor `provider`, `createAgent()` resolves from the
environment: `LOUSHY_MODEL` (a `'provider/model'` string) if set, otherwise
the first provider whose variable is set, checked in this order:
`OPENAI_API_KEY` (`openai/gpt-4o-mini`), `ANTHROPIC_API_KEY`
(`anthropic/claude-3-5-sonnet-latest`), `OPENROUTER_API_KEY`
(`openrouter/openai/gpt-4o-mini`), `OLLAMA_BASE_URL` (`ollama/llama3`). If none
is set it throws an error listing exactly which options or variables fix it.

Misconfiguration errors say how to fix themselves: a missing key names the
variable (`createAgent: OPENAI_API_KEY is not set. ...`), an unknown prefix
lists the supported ones and suggests the closest, and a missing optional peer
dependency prints the exact `npm install` command.

## Project instructions

Many repositories keep guidance for coding agents in an `AGENTS.md` (or
`CLAUDE.md`) file. `createAgent` can append it to the agent's instructions:

```ts
import { createAgent } from '@loushy/build-ai-agent';

const agent = createAgent({
  instructions: 'You review pull requests.',
  provider,
  projectInstructions: true, // or { cwd: './packages/api', files: ['AGENTS.md'] }
});
```

The file is added after your own instructions under the heading
`## Project instructions (from AGENTS.md)`. It is read once, when the agent is
created. The lookup walks up from `cwd` (default `process.cwd()`) and uses the
nearest directory that has one of `files` (default `['AGENTS.md', 'CLAUDE.md']`,
first match wins), stopping at the nearest directory that contains `.git` or at
the filesystem root. Content over 32,000 characters is cut with a truncation
marker. If no file is found nothing is added.

This is **opt-in** on purpose: reading files from disk by default would surprise
people who embed the SDK in a server, where the working directory is not the
project the agent is about. To find the file yourself (for example to show it),
use `loadProjectInstructions({ cwd, files, stopAt, maxChars })`, which returns
`{ path, content }` or `undefined`.

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
| `exporter`                              | A `TraceExporter` for tracing spans (OpenTelemetry GenAI conventions, see [observability](observability.md)). |
| `captureContent`, `redactContent`       | Record message/tool content on `gen_ai.*` span attributes (opt-in) / omit the deprecated content attributes. |
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
