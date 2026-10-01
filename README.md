# @loushy/build-ai-agent

![CI](https://github.com/LinuxDevil/agent-sdk/actions/workflows/ci.yml/badge.svg)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A TypeScript SDK for building AI agents that run in your own code, on your own
host: a typed tool-calling loop with approvals, sessions, streaming,
sub-agents, skills, MCP and a CLI, with no web framework or hosted runtime
required. It is for developers who need an agent to keep working when a run
pauses for a human or the process restarts, and who want to test it like the
rest of their code.

Three things set it apart:

- **Durable sessions and approvals on any host.** Sessions, checkpoints and
  approval pauses live in pluggable stores (memory, files, one SQLite file, or
  Cloudflare KV for checkpoints on Workers), so a paused or interrupted run
  resumes from another request or another process.
- **Record/replay and trajectory evals.** `mockModel` scripts the model,
  `recordReplay` cassettes replay real runs offline, and `defineEval()` asserts
  on which tools were called, in what order, with which arguments, gating CI
  through `loushy eval` with JUnit reports.
- **Node and Cloudflare Workers, traced with OpenTelemetry.** `loushy build`
  ships the same agent spec to a Node server, Docker or a Worker; runs emit
  OpenTelemetry GenAI spans to any exporter, and every result reports token
  usage and USD cost.

[Quickstart](#quickstart) · [Features](#features) · [Documentation](#documentation) ·
[Examples](#examples) · [Docs site](https://linuxdevil.github.io/agent-sdk-docs/)

## Installation

Requires Node.js 22.19 or newer. The package is not on npm yet (it is pre-1.0),
so build it from a checkout and scaffold a project that depends on the build:

```bash
git clone https://github.com/LinuxDevil/agent-sdk.git
cd agent-sdk && npm install && npm run build
node bin/loushy.js init ../my-agent --sdk-path .   # agent, example tool, offline test
cd ../my-agent && cp .env.example .env              # then put your API key in .env
npm run dev                                          # chat in the terminal; `npm test` runs offline
```

To add it to an existing project, install the packed tarball instead
([Installing from a local build](docs/installation.md#installing-from-a-local-build)).
Once published, it will be `npm install @loushy/build-ai-agent ai zod` plus
the provider package you use (`@ai-sdk/openai`, `@ai-sdk/anthropic` or
`ollama-ai-provider`). `npx loushy doctor` checks Node, peers and API keys and
prints a fix for anything missing.

## Quickstart

```ts
import { createAgent } from '@loushy/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini', instructions: 'You are a helpful assistant.' });
const { text } = await agent.send('Hello!');
console.log(text);
```

`model` is a `provider/model` string (`openai`, `anthropic`, `openrouter`,
`ollama`) and the key comes from the provider's usual variable
(`OPENAI_API_KEY`, ...). Leave it out to pick the provider from the
environment, or pass `provider:` with your own or a mock provider. See
[Quick Start](docs/quick-start.md) for runnable, offline versions and
[Providers](docs/providers.md) for the details. Prefer config files? The same
agent can be an `agent.yaml` spec served with `npx loushy dev agent.yaml`
([Configuration](docs/configuration.md)).

## Features

- **Tools**: `defineTool()` with a zod `input`; arguments are typed, validated, and run in parallel. [Tools](docs/tools.md)
- **Approvals and permission policies**: `needsApproval` pauses a run; `agent.approvals.resolve()` continues it, or `approve` decides in code. `permissions` rules allow, deny or ask per tool before that, with an audit log. [Approvals](docs/approvals.md)
- **Ask the user a question**: `createAgent({ askQuestion: true })` adds the built-in `ask_question` tool; the run pauses durably until `agent.approvals.answer()`. [Asking the user a question](docs/approvals.md#asking-the-user-a-question)
- **Sessions**: `agent.session()` keeps a multi-turn conversation in memory, files or SQLite. [Sessions](docs/sessions.md)
- **Memory**: `defineMemory()` slots, scoped globally, per session or per user, are recalled into the prompt at the start of a run and read and written with `remember_` / `recall_` tools. [Memory](docs/memory.md)
- **Structured output**: `output: zodSchema` makes the final reply a typed, validated `result.object`, with one repair step. [Structured output](docs/structured-output.md)
- **Streaming**: `agent.stream()` and `session.stream()` yield typed, versioned JSON events ready for SSE. [Streaming](docs/streaming.md)
- **UI bindings**: `useLoushyAgent()` from `@loushy/build-ai-agent/react` turns the event stream into chat state, with approvals. [React](docs/react.md)
- **Durable execution**: `sessionId` + `checkpointStore` resume a crashed or paused run without redoing finished tools. [Durable execution](docs/durable-execution.md)
- **Cancellation, usage and cost**: pass an `AbortSignal`; every result carries token usage and USD cost for priced models. [API overview](docs/api-overview.md#cancellation)
- **Providers**: OpenAI, Anthropic, OpenRouter, Ollama or a mock, with `withRetry()` and `withFallback()`. [Providers](docs/providers.md)
- **Sub-agents**: `subagents: { researcher, writer }` gives the lead one `task` tool; sub-agents run in parallel. [Sub-agents](docs/sub-agents.md)
- **Skills and AGENTS.md**: `loadSkills()` loads instructions on demand; `projectInstructions` appends your `AGENTS.md`. [Skills](docs/skills.md), [Project instructions](docs/configuration.md#project-instructions)
- **Agent directories**: `loadAgentDir('./my-agent')` builds an agent from `instructions.md`, `tools/` and `skills/`. [Agent directories](docs/agent-directories.md)
- **Compaction**: `createCompactionHook()` prunes old tool results before the context window fills. [Context compaction](docs/compaction.md)
- **MCP client and server**: `createAgent({ mcpServers })` (or `connectMcp()`) connects stdio and HTTP MCP servers from config; `serveMcp()` / `loushy mcp` exposes your agent. [Configuration](docs/configuration.md#connect-mcp-servers-mcpservers-connectmcp)
- **Workspace tools**: file system and shell tools for coding agents, confined to a root, shell approval-gated. [Workspace tools](docs/workspace-tools.md)
- **Hooks, guardrails, sandboxing**: veto tool calls, gate a patch on fail-closed checks, run tools in Docker. [Guardrails](docs/guardrails.md)
- **Channels, flows and triggers**: `defineChannel()` / `mountChannels()` map a surface's messages to sessions and send replies and approvals back; fixed multi-step workflows; webhook, Slack and cron adapters. [Channels](docs/channels.md), [Flows](docs/flows.md), [Triggers](docs/api-overview.md#triggers)
- **Tracing**: OpenTelemetry GenAI spans (`invoke_agent`, `chat`, `execute_tool`); content capture is opt-in. [Observability](docs/observability.md)
- **Testing and evals**: `mockModel`, `recordReplay` cassettes, `defineEval()` trajectory assertions, `loushy eval` with `--record` / `--replay` cassettes and `--drift` trajectory diffs. [Testing](docs/testing.md), [Evals](docs/evals.md)
- **CLI**: `init`, `doctor`, `dev`, `mcp`, `eval`, `build` and `studio`. [CLI](docs/cli.md)
- **Agent Forge**: `loushy studio` opens a visual canvas, run debugger and chat with approval cards. [Agent Forge](docs/agent-forge.md)

## Usage

### A tool-using agent, streamed

```ts
import { createAgent, defineTool } from '@loushy/build-ai-agent';
import { z } from 'zod';

const getWeather = defineTool({
  name: 'get_weather',
  description: 'Current weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21, sky: 'sunny' }), // `city` is a string
});

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  instructions: 'You are a travel assistant. Check the weather before giving advice.',
  tools: [getWeather],
});

for await (const event of agent.stream('What should I wear in Lisbon today?')) {
  if (event.type === 'tool.start') console.log(`\n[${event.toolName}]`, event.args);
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
```

### Pause for approval, then resume

```ts
import { createAgent, defineTool } from '@loushy/build-ai-agent';
import { z } from 'zod';

const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send an email',
  input: z.object({ to: z.string().email(), body: z.string() }),
  needsApproval: ({ to }) => !to.endsWith('@mycompany.com'), // only external mail pauses
  execute: async ({ to }) => ({ sent: true, to }),
});

const agent = createAgent({ model: 'openai/gpt-4o-mini', tools: [sendEmail] });

const run = await agent.send('Email the Q3 summary to sam@example.com');
if (run.finishReason === 'awaiting-approval') {
  const [call] = await agent.approvals.list(); // { id, toolName: 'send_email', args, ... }
  console.log('Approve?', call.toolName, call.args);
  const done = await agent.approvals.resolve({ id: run.approvalId!, approved: true }); // or approved: false, note
  console.log(done.text);
}
```

### Durable sessions with SQLite

```ts
import { createAgent, resolveProvider } from '@loushy/build-ai-agent';
import { SqliteStore } from '@loushy/build-ai-agent/sqlite';

// Transcripts, per-step checkpoints and approvals in one SQLite file, wired by one option.
const agent = createAgent({ provider: resolveProvider('openai/gpt-4o-mini'), store: new SqliteStore('./.loushy/agent.db') });

await agent.resume('user-42'); // after a crash: finishes the interrupted turn without redoing finished steps
const { text } = await agent.session({ id: 'user-42' }).send('What is my name?'); // same id, same conversation
```

## Documentation

| Page | What it covers |
| ---- | -------------- |
| [Installation](docs/installation.md) | Requirements, peer and provider packages, installing from a local build, `loushy init`, `loushy doctor` |
| [Quick Start](docs/quick-start.md) | Runnable, verified snippets: `createAgent()`, tools, `AgentBuilder` + `AgentExecutor`, spec files |
| [Configuration](docs/configuration.md) | Spec fields, `mcpServers`, MCP client and server, provider env vars, retries and fallback, `createAgent()` and `execute()` options |
| [Providers](docs/providers.md) | Model strings, `resolveProvider()`, which model runs, custom providers |
| [CLI](docs/cli.md) | Every `loushy` command and its flags |
| [Tools](docs/tools.md) | `defineTool()`, validation and errors, built-in tools, `ToolRegistry` |
| [Approvals](docs/approvals.md) | `needsApproval`, `agent.approvals`, the `approve` callback, `resumeAfterApproval()`, stores |
| [Sessions](docs/sessions.md) | Multi-turn conversations, `session.stream()`, session stores, `SqliteStore` |
| [Memory](docs/memory.md) | Long-term memory across sessions: `defineMemory()`, scopes, `inMemoryMemory()`, `fileMemory()` |
| [Structured output](docs/structured-output.md) | `output: zodSchema`: typed `result.object`, the repair step, `'output-invalid'` |
| [Streaming](docs/streaming.md) | `agent.stream()`: the typed event schema, terminal and SSE examples |
| [React](docs/react.md) | `useLoushyAgent()`: chat state from the event stream, in process or over HTTP; `reduceAgentEvents()`, `parseEventStream()` |
| [Durable execution](docs/durable-execution.md) | Checkpoints, crash resume, approvals mid-batch, at-least-once tools |
| [Sub-agents](docs/sub-agents.md) | The `subagents` option and its `task` tool, inheritance, approvals in sub-agents |
| [Skills](docs/skills.md) | On-demand instructions: `defineSkill()`, `loadSkills()` |
| [Agent directories](docs/agent-directories.md) | An agent as a folder: layout, mapping to `createAgent()`, security |
| [Context compaction](docs/compaction.md) | Prune old tool results with `createCompactionHook()` |
| [Channels](docs/channels.md) | `defineChannel()`, `mountChannels()`, `httpChannel()`, `webhookChannel()`, `slackChannel()`: surfaces mapped to sessions, replies and approvals sent back |
| [Schedules](docs/schedules.md) | `defineSchedule()` cron schedules, `schedules/` in an agent directory, `startSchedules()` |
| [Flows](docs/flows.md) | Fixed multi-step workflows with `FlowBuilder` and `FlowExecutor` |
| [Workspace tools](docs/workspace-tools.md) | File system and shell tools for coding agents, and their security model |
| [Guardrails and sandboxing](docs/guardrails.md) | `runGuardrails()`, built-in guardrails, `requiresSandbox`, `SubprocessSandbox` |
| [Testing](docs/testing.md) | Deterministic tests with `mockModel`; record and replay with `recordReplay` |
| [Evals](docs/evals.md) | Trajectory evals with `defineEval()`, datasets, judges, `loushy eval` reports |
| [Tracing and observability](docs/observability.md) | OpenTelemetry GenAI spans, attribute table, content opt-in |
| [Deployment](docs/deployment.md) | `loushy build` targets: Node server, Docker, Cloudflare Workers (with KV checkpoints) |
| [Agent Forge](docs/agent-forge.md) | The visual dashboard: quickstart, first-agent walkthrough, hooks |
| [Errors](docs/errors.md) | Every error code (`LOUSHY_*`): what it means, how to fix it, an example |
| [API Overview](docs/api-overview.md) | The main exports, triggers, tokens and cost; `npm run docs:build` generates the full TypeDoc reference |
| [Utilities](docs/utilities.md) | Encryption, file storage and templates |

The full guides site is at [linuxdevil.github.io/agent-sdk-docs](https://linuxdevil.github.io/agent-sdk-docs/).

**For AI coding agents.** The package ships its docs in machine-readable form:
`llms-full.txt` (this README and every docs page in one file, with absolute
links) and `llms.txt` (an [llmstxt.org](https://llmstxt.org) index), both in
the repo root and in `node_modules/@loushy/build-ai-agent/`. They are generated
with `npm run docs:llms` and checked in CI.

## Examples

Most examples run offline with a mock provider; see the
[examples index](examples/README.md) for how to run each one.

| Example | What it shows |
| ------- | ------------- |
| [ops-pipeline](examples/ops-pipeline) | Flagship: monitor alert, Slack "Fix it" button, human approval, fixer agent, guardrail-gated GitHub PR (`npm run pipeline:demo`) |
| [agent-dir](examples/agent-dir) | An agent defined as a directory and loaded with `loadAgentDir()` |
| [support-bot](examples/support-bot) | A minimal customer-support agent |
| [research-assistant](examples/research-assistant) | A research agent with the built-in `http` tool |
| [doc-qa](examples/doc-qa) | Question answering scoped to one document |
| [workflow-router](examples/workflow-router) | Classifying requests into fixed categories |
| [slack-notifier](examples/slack-notifier) | Turning an event into a Slack-ready message |
| [tracing](examples/tracing/run-otel.ts) | OpenTelemetry and console (`run-console.ts`) trace exporters |
| [openrouter](examples/openrouter) | `OpenRouterProvider` features (needs `OPENROUTER_API_KEY`) |

## CLI

| Command | What it does |
| ------- | ------------ |
| `loushy init [dir]` | Scaffold a project with an agent, a tool and an offline test |
| `loushy doctor [spec]` | Check Node, peers, API keys and a spec file; print fixes |
| `loushy dev <spec>` | Local chat UI and `POST /chat` with hot reload |
| `loushy chat <path>` | Terminal REPL: streamed replies, tool calls, approvals and questions |
| `loushy mcp <spec>` | Serve the agent as an MCP server (stdio or HTTP) |
| `loushy eval [globs]` | Run `*.eval.ts` files; JUnit and JSON reports |
| `loushy build --target=<t> --agent=<spec>` | Build a Node server, Docker image or Cloudflare Worker |
| `loushy studio` | Launch Agent Forge |

Flags for each command are in [CLI](docs/cli.md).

**Deployment:** `npx loushy build --target=node-server|docker|cloudflare-worker --agent=agent.yaml`
writes a self-contained artifact and prints the command to run or deploy it
([Deployment](docs/deployment.md)).

## Status

Alpha (`1.0.0-alpha`, pre-1.0): APIs can still change between releases, and
breaking changes are listed in the [CHANGELOG](CHANGELOG.md) with migration
notes. The package is not published to npm yet. Known gaps include killing
the whole process group of a timed-out guardrail command on POSIX (only the
direct child is signalled today) and interactive, in-browser Quick Start
snippets; planned work is in the [ticket catalogue](docs/plan/tickets.md).

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for setup and
the checks a pull request must pass (`npm run typecheck`, `npm run lint`,
`npm test`, `npm run test:coverage && npm run fallow`). Maintainer notes:
[ESLint baseline follow-up](docs/eslint-baseline-followup.md).

## License

MIT © [Build AI Agent](LICENSE)
