# Lousho — TypeScript AI agent SDK

[![npm](https://img.shields.io/npm/v/@lousho/build-ai-agent)](https://www.npmjs.com/package/@lousho/build-ai-agent)
![CI](https://github.com/LinuxDevil/agent-sdk/actions/workflows/ci.yml/badge.svg)
[![Docs](https://img.shields.io/badge/docs-lousho.com-0F9D74)](https://lousho.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Open-source TypeScript SDK for agents that run in your own Node process: tool calling, MCP, sessions that survive a restart, human approvals, and OpenTelemetry. No hosted runtime.

Install with `@lousho/build-ai-agent`.

Four things set it apart:

- **Durable sessions and approvals on any host.** Sessions, checkpoints and
  approval pauses live in pluggable stores (memory, files, one SQLite file, or
  Cloudflare KV on Workers), so a paused or interrupted run
  resumes from another request or another process.
- **Record/replay and trajectory evals.** `mockModel` scripts the model,
  `recordReplay` cassettes replay real runs offline, and `defineEval()` asserts
  on which tools were called, in what order, with which arguments, gating CI
  through `lousho eval` with JUnit reports.
- **Node and Cloudflare Workers, traced with OpenTelemetry.** `lousho build`
  ships the same agent spec to a Node server, Docker or a Worker; runs emit
  OpenTelemetry GenAI spans to any exporter, and every result reports token
  usage and USD cost.
- **Coding agents that ship.** Agents are plain directories (`agent.json`,
  `instructions.md`, `tools/`, `subagents/`), registries install them as kits,
  and `piAgent()` delegates real coding work to a Pi coding agent with durable
  approvals - one `lousho add coding-pi` is a working coding harness.

[Quickstart](#quickstart) · [Features](#features) · [Examples](#examples) ·
[TypeScript AI agent quickstart](docs/quick-start.md) ·
[Connect an agent to MCP servers](docs/mcp.md) ·
[Durable sessions that survive a restart](docs/durable-execution.md) ·
[Human-in-the-loop tool approvals](docs/approvals.md) ·
[OpenTelemetry tracing](docs/observability.md) ·
[Docs](https://lousho.com/introduction)

## Installation

Requires Node.js 22.19 or newer (the floor comes from the `undici@8` dependency; `.ts` agent files also rely on Node's built-in type stripping, on by default since 22.18). Scaffold a new project with one command:

```bash
npm create lousho-agent my-agent                     # agent, example tool, offline test
cd my-agent                                          # copy .env.example to .env (cp on macOS/Linux, copy on Windows), put your API key in it
npm run dev                                          # chat in the terminal; `npm test` runs offline
```

To add it to an existing project, install the SDK with the current `ai` major
and the provider packages that pair with it:

```bash
npm install @lousho/build-ai-agent ai@^7.0.0 zod
npm install @ai-sdk/openai@^4.0.0 @ai-sdk/anthropic@^4.0.0
```

For Ollama, use `ai@^7.0.0` with `ollama-ai-provider-v2@^4.0.0` and zod 4 (or
`ai@^4.3.19` with `ollama-ai-provider@^1.2.0` and zod 3);
[Installation](docs/installation.md#provider-packages) lists every pairing. `npx lousho doctor` checks Node, peers and API keys and
prints a fix for anything missing.

## Quickstart

The snippet uses top-level `await`, so the file must be an ES module (`.mts`, or `"type": "module"` in `package.json`).

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini', instructions: 'You are a helpful assistant.' });
const { text } = await agent.send('Hello!');
console.log(text);
```

`model` is a `provider/model` string (`openai`, `anthropic`, `openrouter`,
`ollama`, `pi`) and the key comes from the provider's usual variable
(`OPENAI_API_KEY`, ...). Leave it out to pick the provider from the
environment, or pass `provider:` with your own or a mock provider. See
[Quick Start](docs/quick-start.md) for runnable, offline versions and
[Providers](docs/providers.md) for the details. Prefer config files? The same
agent can be an `agent.yaml` spec served with `npx lousho dev agent.yaml`
([Configuration](docs/configuration.md)).

## Features

- **Tools**: `defineTool()` with a zod `input`; arguments are typed, validated, and run in parallel. [Tools](docs/tools.md)
- **Approvals and permission policies**: `needsApproval` pauses a run; `agent.approvals.resolve()` continues it, or `approve` decides in code. `permissions` rules allow, deny or ask per tool before that, with an audit log. [Approvals](docs/approvals.md)
- **Ask the user a question**: `createAgent({ askQuestion: true })` adds the built-in `ask_question` tool; the run pauses durably until `agent.approvals.answer()`. [Asking the user a question](docs/approvals.md#asking-the-user-a-question)
- **Sessions**: `agent.session()` keeps a multi-turn conversation in memory, files or SQLite. [Sessions](docs/sessions.md)
- **Memory**: `defineMemory()` slots, scoped globally, per session or per user, are recalled into the prompt at the start of a run and read and written with `remember_` / `recall_` tools. [Memory](docs/memory.md)
- **Structured output**: `output: zodSchema` makes the final reply a typed, validated `result.object`, with one repair step. [Structured output](docs/structured-output.md)
- **Streaming**: `agent.stream()` and `session.stream()` yield typed, versioned JSON events ready for SSE. [Streaming](docs/streaming.md)
- **UI bindings**: `useLoushoAgent()` from `@lousho/build-ai-agent/react` (and `/vue`; `loushoAgent()` store from `/svelte`) turns the event stream into chat state, with approvals. [React](docs/react.md), [Vue](docs/vue.md), [Svelte](docs/svelte.md)
- **AI SDK UI**: `toUIMessageStreamResponse(agent.stream(...))` renders a run with the Vercel AI SDK's `useChat`. [AI SDK UI](docs/ai-sdk-ui.md)
- **Next.js and Fetch frameworks**: `createRouteHandler(agent)` serves the session API from an App Router, SvelteKit, Hono or Bun route. [Next.js](docs/nextjs.md)
- **Durable execution**: `createAgent({ store })` checkpoints every step, and `agent.resume()` finishes a crashed or interrupted run without redoing finished tools (it throws `SessionAwaitingApprovalError` on an approval-paused run, which continues via `agent.approvals.resolve()`). [Durable execution](docs/durable-execution.md)
- **Cancellation, usage and cost**: pass an `AbortSignal`; every result carries token usage and USD cost for priced models. [Runs](docs/runs.md), [Models and cost](docs/models-and-cost.md)
- **Providers**: OpenAI, Anthropic, OpenRouter, Ollama or a mock, with `withRetry()` and `withFallback()`; `pi/<provider>/<model>` routes through `@earendil-works/pi-ai`, opening Pi's whole catalog (OpenRouter, Anthropic, OpenAI, Google, ...) in one spec space. [Providers](docs/providers.md)
- **Sub-agents**: `subagents: { researcher, writer }` gives the lead a `task` tool plus `agent_status`, `agent_await` and `agent_cancel` for background tasks; sub-agents run in parallel. `remoteAgent()` delegates to a deployed agent over HTTP, `piAgent()` to a Pi coding agent in process - both durable-resumable - and `defineRemoteSubagent()` covers your own backend. [Sub-agents](docs/sub-agents.md)
- **Handoffs**: `handoffs: [billing, support]` lets a triage agent hand the conversation to a specialist, which answers the user and keeps the session. [Handoffs](docs/handoffs.md)
- **Skills and AGENTS.md**: `loadSkills()` loads instructions on demand; `projectInstructions` appends your `AGENTS.md`. [Skills](docs/skills.md), [Project instructions](docs/configuration.md#project-instructions)
- **Agent directories**: `loadAgentDir('./my-agent')` builds an agent from `agent.json`, `instructions.md`, `tools/` and `skills/` - config covers models, permission rules and modes, hooks, approvers, compaction, limits and per-family instruction tails; `subagents/<name>/` with `"engine": "pi"` is a Pi coding sub-agent sharing the workspace. [Agent directories](docs/agent-directories.md)
- **Compaction**: `createAgent({ compaction })` prunes old tool results, then summarizes old turns, before the context window fills. [Context compaction](docs/compaction.md)
- **MCP client and server**: `createAgent({ mcpServers })` (or `connectMcp()`) connects stdio and HTTP MCP servers from config; `serveMcp()` / `lousho mcp` exposes your agent. [MCP](docs/mcp.md)
- **Workspace tools**: file system and shell tools for coding agents, confined to a root, shell approval-gated. [Workspace tools](docs/workspace-tools.md)
- **Hooks, guardrails, sandboxing**: veto tool calls, gate a patch on fail-closed checks, run tools in Docker. [Guardrails](docs/guardrails.md)
- **Channels, flows and triggers**: `defineChannel()` / `mountChannels()` map a surface's messages to sessions and send replies and approvals back; fixed multi-step workflows; webhook, Slack and cron adapters. [Channels](docs/channels.md), [Flows](docs/flows.md), [Triggers](docs/triggers.md)
- **Tracing**: OpenTelemetry GenAI spans (`invoke_agent`, `chat`, `execute_tool`); content capture is opt-in. [Observability](docs/observability.md)
- **Trace viewer**: `createAgent({ exporter: fileTraceExporter() })` keeps each run as a local file; `npx lousho traces` lists runs and prints one as a tree with durations, tokens and cost. [Local traces](docs/observability.md#local-traces)
- **Testing and evals**: `mockModel`, `recordReplay` cassettes, `defineEval()` trajectory assertions, `lousho eval` with `--record` / `--replay` cassettes and `--drift` trajectory diffs. [Testing](docs/testing.md), [Evals](docs/evals.md)
- **CLI**: `init`, `doctor`, `dev`, `chat`, `acp`, `add`, `mcp`, `eval`, `traces`, `build` and `studio`. [CLI](docs/cli.md)
- **Editors (ACP)**: `lousho acp ./my-agent` serves your agent to Zed and other Agent Client Protocol editors, with tool calls and permission prompts. [ACP](docs/acp.md)
- **Registry**: `lousho add <name>` copies a tool, skill, channel, schedule, memory slot or **kit** - a whole agent directory - into yours from the default registry (or one you point at with `--registry <url-or-path>`), after showing its permissions. The built-in `coding-kit` and `coding-pi` kits are production-shaped coding harnesses. [Registry](docs/registry.md)
- **Agent Forge** (the `lousho studio` command): a visual canvas, run debugger and chat with approval cards. [Agent Forge](docs/agent-forge.md)

## Usage

### A tool-using agent, streamed

```ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
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
import { createAgent, defineTool } from '@lousho/build-ai-agent';
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
import { createAgent, resolveProvider } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';

// Transcripts, per-step checkpoints and approvals in one SQLite file, wired by one option.
const agent = createAgent({ provider: resolveProvider('openai/gpt-4o-mini'), store: new SqliteStore('./.lousho/agent.db') });

await agent.resume('user-42'); // after a crash: finishes the interrupted turn without redoing finished steps
const { text } = await agent.session({ id: 'user-42' }).send('What is my name?'); // same id, same conversation
```

### A coding agent from the registry

```bash
lousho add coding-pi --dir ./my-agent --yes --allow exec,fs-write,network,env
OPENROUTER_API_KEY=... lousho dev ./my-agent
```

`coding-pi` is a whole agent directory: workspace file tools with checkpoint
rewind, an allow-listed shell, permission rules (`rm` denied, writes to
`*.test.*` refused), a loop guard, a cost cap, a read-only explorer and a Pi
coding sub-agent the lead delegates to through `task`. `coding-kit` is the
same rails on the standard providers. Both were validated live over
OpenRouter.

## Documentation

| Page | What it covers |
| ---- | -------------- |
| [Installation](docs/installation.md) | Requirements, peer and provider packages, installing from a local build, `lousho init`, `lousho doctor` |
| [Upgrading to 1.0](docs/upgrading.md) | From `1.0.0-alpha.*`: moved imports, removed and renamed APIs, deprecations, what 1.0 promises |
| [Quick Start](docs/quick-start.md) | Runnable, verified snippets: `createAgent()`, tools, streaming, sessions, approvals, offline tests, spec files |
| [Configuration](docs/configuration.md) | Spec fields, the `mcpServers` field, provider env vars, retries and fallback, `createAgent()` options, budgets, project instructions |
| [MCP](docs/mcp.md) | Use MCP servers as tools (`mcpServers`, `connectMcp()`, `loadMcpTools()`), approval for MCP tools, serve an agent with `serveMcp()` / `lousho mcp` |
| [Connectors](docs/connectors.md) | Connect to Google Docs, Slack, GitHub, Notion: the connector table, OAuth sign-in, approval for connector writes |
| [OpenAPI tools](docs/openapi-tools.md) | `openApiTools()`: an OpenAPI 3.0 / 3.1 document becomes one tool per operation, with approval for mutating ones |
| [Providers](docs/providers.md) | Model strings, `resolveProvider()`, which model runs, custom providers |
| [CLI](docs/cli.md) | Every `lousho` command and its flags |
| [ACP](docs/acp.md) | `lousho acp` / `serveAcp()`: drive an agent from Zed and other Agent Client Protocol editors |
| [Tools](docs/tools.md) | `defineTool()`, validation and errors, built-in tools, `ToolRegistry` |
| [Hosted tools](docs/hosted-tools.md) | `webSearch()`, `codeInterpreter()`, `fileSearch()`, `hostedTool()`: tools the provider runs inside the request |
| [Approvals](docs/approvals.md) | `needsApproval`, `agent.approvals`, the `approve` callback, `resumeAfterApproval()`, stores |
| [Permission modes](docs/permission-modes.md) | `permissionMode: 'plan' \| 'acceptEdits' \| 'dontAsk'`, `session.setPermissionMode()`, the `editsFiles` marker |
| [Sessions](docs/sessions.md) | Multi-turn conversations, `session.stream()`, session stores, `SqliteStore` |
| [Memory](docs/memory.md) | Long-term memory across sessions: `defineMemory()`, scopes, `inMemoryMemory()`, `fileMemory()` |
| [Structured output](docs/structured-output.md) | `output: zodSchema`: typed `result.object`, the repair step, `'output-invalid'` |
| [Reasoning](docs/reasoning.md) | The `reasoning` option per provider, `reasoning.*` events, `result.reasoning` |
| [Streaming](docs/streaming.md) | `agent.stream()`: the run handle, listeners, terminal and SSE examples |
| [Stream events](docs/stream-events.md) | The typed, versioned event schema, ordering guarantees, `isAgentEvent()` |
| [Queued input and steering](docs/queue-and-steer.md) | `run.enqueue()` and `run.steer()`: add input to a running run or redirect it |
| [Runs](docs/runs.md) | Finish reasons, cancellation with `AbortSignal`, parallel tool calls |
| [Models and cost](docs/models-and-cost.md) | Token estimates, the model price table, usage and USD cost of a run |
| [AI SDK UI](docs/ai-sdk-ui.md) | `useChat` on a Lousho run: `toUIMessageStreamResponse()`, `fromUIMessages()`, approvals |
| [Next.js](docs/nextjs.md) | `createRouteHandler(agent)`: the session API as a Fetch route (App Router, SvelteKit, Hono), auth, `useChat` endpoint |
| [Route auth](docs/auth.md) | `@lousho/build-ai-agent/auth`: `jwt()`, `oidc()`, `basic()`, `apiToken()` as an ordered list; the caller as `principal` in the run |
| [React](docs/react.md) | `useLoushoAgent()`: chat state from the event stream, in process or over HTTP; `reduceAgentEvents()`, `parseEventStream()` |
| [Vue](docs/vue.md) | `useLoushoAgent()` from `@lousho/build-ai-agent/vue`: the React hook as a Vue 3 composable |
| [Svelte](docs/svelte.md) | `loushoAgent()` from `@lousho/build-ai-agent/svelte`: the React hook as a Svelte store |
| [Durable execution](docs/durable-execution.md) | Checkpoints, crash resume, approvals mid-batch, at-least-once tools |
| [Sub-agents](docs/sub-agents.md) | The `subagents` option and its `task` tool, inheritance, approvals in sub-agents |
| [Handoffs](docs/handoffs.md) | `handoffs: [billing, support]`: hand the conversation to another agent, input filters, sessions, approvals after a handoff |
| [Tool search](docs/tool-search.md) | `deferLoading` on tools and MCP servers: the model finds tools with `tool_search` instead of receiving every definition |
| [Code mode](docs/code-mode.md) | `codeMode`: the model calls several tools from one sandboxed JavaScript program (`run_code`) |
| [Skills](docs/skills.md) | On-demand instructions: `defineSkill()`, `loadSkills()` |
| [Agent directories](docs/agent-directories.md) | An agent as a folder: layout, mapping to `createAgent()`, security |
| [Claude Code projects](docs/claude-projects.md) | `claudeProject()`: load a repo's `CLAUDE.md` and `.claude/{skills,agents,rules,scratchpad}` into `createAgent()` — same files, both harnesses |
| [Prompting and context techniques](docs/prompting-techniques.md) | The catalog: few-shot, CoT, ReAct, context write/select/compress/isolate, waves, phases, typed decisions — each mapped to its Lousho surface |
| [Context compaction](docs/compaction.md) | `createAgent({ compaction })`: prune old tool results, then summarize old turns |
| [Channels](docs/channels.md) | `defineChannel()`, `mountChannels()`, `httpChannel()`, `webhookChannel()`, `slackChannel()`: surfaces mapped to sessions, replies and approvals sent back |
| [Schedules](docs/schedules.md) | `defineSchedule()` cron schedules, `schedules/` in an agent directory, `startSchedules()` |
| [Triggers](docs/triggers.md) | `@lousho/build-ai-agent/triggers`: webhook, Slack and cron adapters, `TriggerAdapter`, `TriggerRegistry`; triggers vs channels vs schedules |
| [Flows](docs/flows.md) | Fixed multi-step workflows with `FlowBuilder` and `FlowExecutor` |
| [Workspace tools](docs/workspace-tools.md) | File system and shell tools for coding agents, and their security model |
| [Build a coding agent](docs/build-a-coding-agent.md) | A terminal coding agent step by step: workspace tools, approvals, streaming, a session, offline tests |
| [Hooks](docs/hooks.md) | `createAgent({ hooks })`: observe, deny, rewrite or redact tool calls and model calls; `HookRegistry` |
| [OAuth](docs/oauth.md) | `AgentStore.tokens`: OAuth tokens per provider and credential owner (app or user), encrypted at rest with your `tokenKey` |
| [Guardrails and sandboxing](docs/guardrails.md) | `runPatchChecks()`, built-in guardrails, `requiresSandbox`, `SubprocessSandbox` |
| [Testing](docs/testing.md) | Deterministic tests with `mockModel`; record and replay with `recordReplay` |
| [Evals](docs/evals.md) | Trajectory evals with `defineEval()`, datasets, judges, `lousho eval` reports |
| [Tracing and observability](docs/observability.md) | OpenTelemetry GenAI spans, attribute table, content opt-in, local traces and `lousho traces` |
| [Deployment](docs/deployment.md) | `lousho build` targets: Node server, Docker, Cloudflare Workers (with KV checkpoints) |
| [Hostinger VPS](docs/hostinger-vps.md) | Deploy to a Hostinger VPS: API verification, `docker save` over SSH, post-install scripts, health checks, approval testing |
| [Cloudflare Workers](docs/cloudflare-workers.md) | What the Worker target supports and what it does not, bindings, KV stores, cron triggers |
| [Registry](docs/registry.md) | `lousho add`: copy a tool, skill, channel, schedule or memory slot from a static JSON registry (a default one is built in) |
| [Agent Forge](docs/agent-forge.md) | The visual dashboard: quickstart, first-agent walkthrough, hooks |
| [Errors](docs/errors.md) | Every error code (`LOUSHO_*`): what it means, how to fix it, an example |
| [Troubleshooting](docs/troubleshooting.md) | Start from the symptom: setup, runs that end without an answer, tools, providers, sandbox and MCP; cause, fix, link |
| [API Overview](docs/api-overview.md) | The main exports; `npm run docs:build` generates the full TypeDoc reference |
| [Utilities](docs/utilities.md) | Encryption, hashing and file storage |
| [The executor API](docs/executor-api.md) | `AgentBuilder` and `AgentExecutor`: the lower-level options `createAgent()` does not take |
| [Migrating to createAgent()](docs/migrating-to-create-agent.md) | From `AgentBuilder`, `AgentExecutor` and `resumeAfterApproval()` to `createAgent()`: before and after, a mapping table, what it does not take yet |

The full guides are at [lousho.com](https://lousho.com), in English and Arabic.

**For AI coding agents.** The repo carries its docs in machine-readable form:
`llms-full.txt` (this README and every docs page in one file, with absolute
links) and `llms.txt` (an [llmstxt.org](https://llmstxt.org) index), both in
the repo root. Only the small `llms.txt` index (and the `docs/*.md` pages it
links to) is in the npm package; fetch `llms-full.txt` from the repo. They are
generated with `npm run docs:llms` and checked in CI.

## Examples

Most examples run offline with a mock provider; see the
[examples index](examples/README.md) for how to run each one.

| Example | What it shows |
| ------- | ------------- |
| [ops-pipeline](examples/ops-pipeline) | Flagship: monitor alert, Slack "Fix it" button, human approval, fixer agent, patch-check-gated GitHub PR (`npm run pipeline:demo`) |
| [coding-harness](examples/coding-harness) | A production-shaped coding agent: checkpoints, permission rules, loop guard, the `coding-kit` and `coding-pi` registry kits, live OpenRouter runs |
| [deep-research](examples/deep-research) | Coordinator fans out parallel `task` calls to researcher sub-agents, then synthesizes a cited report |
| [support-desk](examples/support-desk) | Triage agent `handoff()`s to billing/tech specialists; approval-gated refund tool |
| [evaluator-loop](examples/evaluator-loop) | Writer/critic loop: `llmCritique()` scores a draft and returns feedback until it passes |
| [data-analyst](examples/data-analyst) | Text-to-SQL over `node:sqlite` with read-only enforcement — `DELETE`/`DROP` can never run |
| [plan-mode](examples/plan-mode) | Read and propose in `plan` mode, then apply edits after `setPermissionMode('acceptEdits')` |
| [waves](examples/waves) | WAVE engineering: bounded parallel workers, deterministic aggregate, typed verify gate, extend only on named gaps |
| [phase-pipeline](examples/phase-pipeline) | Phase engineering on flows: discuss → spec → plan → implement → proof gate, `oneOf` retry ladder |
| [coding-agent-workflows](examples/coding-agent-workflows) | Jev-style typed decisions routing a coding agent between fix/refactor/explain workflows, confidence-floor escalation |
| [connectors](examples/connectors) | MCP connectors (Google Docs/Slack shape) run offline against a mock `serveMcp` stdio server |
| [hostinger-deploy](examples/hostinger-deploy) | Deploy an agent to a real Hostinger VPS: API check, docker build+ship over SSH, health + approval smoke tests |
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
| `lousho init [dir]` | Scaffold a project with an agent, a tool and an offline test |
| `lousho doctor [spec]` | Check Node, peers, API keys and a spec file; print fixes |
| `lousho dev <spec>` | Local chat UI and `POST /chat` with hot reload |
| `lousho chat <path>` | Terminal REPL: streamed replies, tool calls, approvals and questions |
| `lousho acp <path>` | Serve the agent to Zed and other Agent Client Protocol editors |
| `lousho add <name> [--registry <url-or-path>]` | Copy a tool, skill, channel, schedule, memory slot or kit (a whole agent directory) from the default registry (or a given one) into an agent directory |
| `lousho mcp <spec>` | Serve the agent as an MCP server (stdio or HTTP) |
| `lousho eval [globs]` | Run `*.eval.ts` files; JUnit and JSON reports |
| `lousho traces [id]` | List saved runs, or print one as a span tree |
| `lousho build --target=<t> --agent=<spec>` | Build a Node server, Docker image or Cloudflare Worker |
| `lousho studio` | Launch Agent Forge, the visual studio |

Flags for each command are in [CLI](docs/cli.md).

**Deployment:** `npx lousho build --target=node-server|docker|cloudflare-worker --agent=agent.yaml`
writes a self-contained artifact and prints the command to run or deploy it
([Deployment](docs/deployment.md)).

## Status

Alpha (`1.0.0-alpha`, pre-1.0): APIs can still change between releases, and
breaking changes are listed in the [CHANGELOG](CHANGELOG.md) with migration
notes. Known gaps:

- Docker sandbox egress (`network: { allow }`) and the credential broker need
  Docker Engine on Linux; Docker Desktop is refused
  ([Workspace tools](docs/workspace-tools.md)).
- File (non-image) parts reach the model only for media types the provider
  accepts (`application/pdf` for OpenAI and OpenRouter, `application/pdf` and
  `text/plain` for Anthropic, on `ai` 6/7); other types - and every file part
  on `ai` 4 - are replaced by a text note ([Providers](docs/providers.md)).
- The `pi` provider and `piAgent()` are Node-only (they run Pi's engine);
  `lousho build --target=cloudflare-worker` refuses `pi/...` model specs and
  `engine: 'pi'` sub-agent directories.
- The Cloudflare Worker target has a limited provider and tool set, and builds
  agent directories without sub-agents, schedules, channels or memory slots
  ([Cloudflare Workers](docs/cloudflare-workers.md)).

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for setup and
the checks a pull request must pass (`npm run typecheck`, `npm run lint`,
`npm test`, `npm run test:coverage && npm run fallow`).

## License

MIT © [Lousho Team](LICENSE)
