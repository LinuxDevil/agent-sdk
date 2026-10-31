# Comparison with other agent frameworks

**As of October 2026.** This page is a short orientation, not a benchmark.
The TypeScript agent space moves fast: most of the projects below now ship
durable approvals, evals and coding-agent harnesses of their own, so check
their documentation before deciding. Rows about lousho describe this
repository and link to the page that documents each claim.

## Each project in one row

| Project | What it is | Approvals / human-in-the-loop | Evals | Coding agents | Where it is ahead of lousho |
| ------- | ---------- | ----------------------------- | ----- | ------------- | --------------------------- |
| lousho (`lousho`) | Self-hosted TypeScript agent SDK, one npm package, alpha | `needsApproval` + `resumeAfterApproval()` on memory, file, SQLite or Cloudflare KV stores ([Approvals](./approvals.md)) | `lousho eval`: trajectory assertions, record/replay cassettes, drift reports ([Evals](./evals.md)) | Workspace tools, permission rules, `piAgent()`, registry kits, ACP editor server ([Build a coding agent](./build-a-coding-agent.md)) | - |
| [Vercel AI SDK 7](https://ai-sdk.dev) | Model, agent and UI toolkit for TypeScript | `WorkflowAgent` tools take `needsApproval`; runs are durable through the open-source Workflow DevKit | Not built in | `HarnessAgent` (experimental) wraps existing runtimes such as Claude Code behind one API | By far the most providers and UI integrations; lousho uses it underneath for the standard providers |
| [Mastra](https://mastra.ai) | Full-stack TypeScript framework: agents, workflows, memory, RAG, dev UI | Workflow `suspend()` / `resume()` with persisted snapshots | Scorers, datasets and experiments, with results stored | Build it from agents, tools and workflows | Postgres and many other storage adapters, a local dev playground, a larger community |
| [LangGraph.js](https://langchain-ai.github.io/langgraphjs/) | Graph-shaped, stateful workflows with checkpointing | `interrupt()` + `Command({ resume })` on any checkpointer | Through LangSmith (hosted) | Build it as a graph | Postgres checkpointer, explicit control flow, LangSmith tracing and evals |
| [OpenAI Agents SDK (JS)](https://openai.github.io/openai-agents-js/) | Agents around OpenAI's APIs: handoffs, guardrails, tracing | Tool approvals with run-state resume | Through OpenAI's platform | Sandbox agents (beta) that read files, run commands and apply patches | First-class OpenAI hosted tools and sandboxes, OpenAI tracing dashboard |
| [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) | The Claude Code agent loop as a library | `canUseTool` callback, hooks, permission modes and rules | Not built in | It *is* a coding agent: file, shell and edit tools, sessions, subagents | A production coding harness out of the box; Claude models |
| [eve](https://github.com/vercel/eve) | Vercel's filesystem-first agent framework (Apache-2.0, beta) | Human-in-the-loop prompts on durable runs | `eve eval` with `defineEval`, asserting on tool calls | Sandboxes, channels (Slack, Discord, HTTP), schedules | Deploy and operations on Vercel, AI Gateway models, channels. Its `agent/` directory layout (`instructions.md`, `tools/`, `skills/`) mirrors lousho's [agent directories](./agent-directories.md) |
| [VoltAgent](https://voltagent.dev) | TypeScript framework: agents, memory, workflows | Workflow suspend/resume | Built-in evals | Build it from agents and tools | VoltOps observability console and dashboards |
| [open-harness](https://github.com/MaxGfeller/open-harness) | MIT TypeScript SDK on the AI SDK, modelled on Claude Code and Codex | Tool permissions | Not built in | Filesystem and bash tools, subagents, skills, MCP, compaction | Small, composable harness core focused on coding agents |

## What lousho still does differently

Each item is checkable in this repository.

- **Record/replay cassettes and trajectory drift in one CLI.** `lousho eval --record`
  runs every case against the real provider once and writes a cassette,
  `--replay` runs them in CI with no network and no API key, and `--drift`
  re-records into a temp directory and reports how each case's tool-call
  trajectory changed ([Evals](./evals.md#record-replay-and-drift),
  [Testing](./testing.md#record-and-replay)).
- **Durable approvals on Cloudflare Workers KV** as well as memory, file and
  SQLite, with the same `needsApproval` / `resumeAfterApproval()` code on each
  ([Durable execution](./durable-execution.md), [Cloudflare Workers](./cloudflare-workers.md)).
- **Self-hosted, one package, no platform account.** Runs in your Node process,
  Docker or a Worker; nothing calls home and there is no hosted control plane to sign up for.
- **Spans AI SDK majors.** The `ai` peer dependency accepts `^4.3.19`, `^6` and
  `^7`, so an existing app can adopt lousho without first upgrading the AI SDK
  ([Installation](./installation.md)).

## Where lousho is weaker

- **Alpha, one maintainer.** The 1.0 line is still `1.0.0-alpha.*`. Expect API churn, a small community and few third-party integrations.
- **No Postgres store.** Checkpoint and approval stores ship for memory, file, SQLite and Cloudflare KV. Mastra and LangGraph ship Postgres; here you implement the small `CheckpointStore` / `ApprovalStore` interfaces yourself.
- **Fewer native providers.** OpenAI, Anthropic, OpenRouter, Ollama and the Pi catalog are built in; anything else goes through `fromAiSdk()` ([Providers](./providers.md)).
- **No hosted dashboard.** Traces are OpenTelemetry spans you send to your own backend ([Observability](./observability.md)); there is no hosted equivalent of LangSmith or VoltOps. Agent Forge (`lousho studio`) is a local visual console, not a hosted service ([Agent Forge](./agent-forge.md)).
- **The root entry point is not edge-safe.** Cloudflare Workers use the dedicated `worker` build and subpaths ([Cloudflare Workers](./cloudflare-workers.md)).
- **Live runs are manual.** CI runs offline tests and cassette replays; live-provider checks are run by hand.

## Picking one

If you only need model calls with streaming UI, the Vercel AI SDK alone is the
simpler choice. If you want a ready-made coding agent, start from the Claude
Agent SDK or an AI SDK harness. If you want an all-in-one framework with a dev
UI and Postgres, look at Mastra; if your control flow is a graph, LangGraph.js;
if you deploy on Vercel, eve. Pick lousho when you want offline
record/replay evals, approvals that survive a restart on your own stores
(including Workers KV), and one self-hosted package with no platform account.
