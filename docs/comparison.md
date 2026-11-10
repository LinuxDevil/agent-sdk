# How Lousho compares

This page compares Lousho with four other TypeScript agent libraries: the Vercel
AI SDK (`ToolLoopAgent`), the OpenAI Agents SDK for JavaScript, Mastra and
LangGraph.js. Each competitor cell comes from that project's official docs.

Last checked: 9 Nov 2026. These projects move fast, so a cell may be out of
date. Corrections welcome: [open an issue](https://github.com/LinuxDevil/agent-sdk/issues).

## How to read the table

- ✅ means the official docs show the feature.
- partial means the docs show part of it, or it needs another product. The
  footnote says what exists.
- ❌ means we did not find the feature in the project's official docs. The
  footnote links the page we read.
- unverified means the official docs did not let us confirm the cell either way.

Each Lousho ✅ links to the Lousho page that documents it.

## The table

| | Lousho | Vercel AI SDK (ToolLoopAgent) | OpenAI Agents SDK (JS) | Mastra | LangGraph.js |
|---|---|---|---|---|---|
| Runs in your own process | ✅ ([quick start](./quick-start.md)) | ✅ | ✅ | ✅ | ✅ |
| Durable resume after a crash | ✅ ([durable execution](./durable-execution.md#recovering-after-a-crash)) | partial[^v-durable] | ❌[^o-durable] | ✅ | ✅ |
| Human approval with pause/resume across processes | ✅ ([pause, restart, resume](./pause-and-resume.md)) | ✅ | ✅ | ✅ | ✅ |
| Offline record/replay evals | ✅ ([evals](./evals.md#record-replay-and-drift)) | partial[^v-evals] | partial[^o-evals] | partial[^m-evals] | partial[^l-evals] |
| MCP client | ✅ ([MCP](./mcp.md#use-mcp-servers-in-an-agent)) | ✅ | ✅ | ✅ | ✅ |
| MCP server | ✅ ([MCP](./mcp.md#serve-an-agent-over-mcp)) | partial[^v-mcp] | ❌[^o-mcp] | ✅ | partial[^l-mcp] |
| React/Vue/Svelte bindings | ✅ ([React](./react.md), [Vue](./vue.md), [Svelte](./svelte.md)) | ✅ | ❌[^o-ui] | partial[^m-ui] | ✅ |
| OpenTelemetry | ✅ ([observability](./observability.md)) | ✅ | ❌[^o-otel] | ✅ | unverified[^l-otel] |
| Local studio/debugger | ✅ ([Agent Forge](./agent-forge.md)) | ✅ | ❌[^o-studio] | ✅ | partial[^l-studio] |
| Provider-agnostic | ✅ ([providers](./providers.md)) | ✅ | ✅ | ✅ | ✅ |
| Licence | MIT | Apache-2.0 | MIT | Apache-2.0, with some parts under a separate licence[^m-licence] | MIT |

[^v-durable]: A `ToolLoopAgent` runs in memory and loses its progress on a crash. The separate `WorkflowAgent` from `@ai-sdk/workflow` is durable and survives restarts, but it runs inside a Workflow runtime. See [WorkflowAgent](https://ai-sdk.dev/docs/agents/workflow-agent).
[^o-durable]: The docs show a run's state saved and resumed only when it stops for an approval (`RunState`). We found no checkpointing that lets a crashed run resume. See [Human-in-the-loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/).
[^v-evals]: The AI SDK has mock models and stream helpers for tests. We found no way to record a real run and replay it, or to report trajectory drift. See [Testing](https://ai-sdk.dev/docs/ai-sdk-core/testing).
[^o-evals]: `@openai/agents/testing` has a `ScriptedModel` that runs offline, and a recipe to detect workflow drift. The scripted steps are written by hand, not recorded from a real run. See [Testing](https://openai.github.io/openai-agents-js/guides/testing/).
[^m-evals]: Experiments can mock tool outputs on dataset items, and there is a trajectory accuracy scorer. We found no recording of real model responses for offline replay. See [Experiments](https://mastra.ai/docs/evals/experiments) and [Built-in scorers](https://mastra.ai/docs/evals/built-in-scorers).
[^l-evals]: `agentevals` can match a run against a trajectory you write by hand, with no model calls. HTTP caching for tests is documented for Python (pytest), not for the JS Vitest/Jest integration. See [Evals](https://docs.langchain.com/oss/javascript/langchain/evals) and [Vitest/Jest](https://docs.langchain.com/langsmith/vitest-jest).
[^v-mcp]: Vercel documents a separate `mcp-handler` package for building MCP servers. It is not part of the AI SDK and has no helper to serve an agent. See [Deploy MCP servers to Vercel](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel).
[^o-mcp]: The MCP guide covers connecting to MCP servers. We found no API to serve an agent as an MCP server. See [MCP](https://openai.github.io/openai-agents-js/guides/mcp/).
[^l-mcp]: Agent Server, including the local `langgraph dev` server, exposes agents at `/mcp`. We found no way to do it from the library alone. See [MCP endpoint in Agent Server](https://docs.langchain.com/langsmith/server-mcp).
[^o-ui]: We found no React, Vue or Svelte UI hooks in the docs. See the [full docs](https://openai.github.io/openai-agents-js/llms-full.txt).
[^m-ui]: Mastra has a first-party React package and a client SDK. Svelte works through the AI SDK's `@ai-sdk/svelte` with `@mastra/ai-sdk`. We found no Vue page. See [Mastra Client](https://mastra.ai/docs/server/mastra-client), [AI SDK UI](https://mastra.ai/integrations/agentic-ui/ai-sdk-ui) and [SvelteKit](https://mastra.ai/integrations/frameworks/sveltekit).
[^o-otel]: Traces go to the OpenAI dashboard by default, and you can add your own trace processors. The docs do not mention OpenTelemetry. See [Tracing](https://openai.github.io/openai-agents-js/guides/tracing/).
[^l-otel]: LangSmith accepts OpenTelemetry spans, but every setup example is in Python. We could not confirm the JS setup. See [Trace with OpenTelemetry](https://docs.langchain.com/langsmith/trace-with-opentelemetry).
[^o-studio]: Runs are inspected in the hosted Traces dashboard. We found no local UI. See [Tracing](https://openai.github.io/openai-agents-js/guides/tracing/).
[^l-studio]: `langgraph dev` runs a local server, and Studio connects to it. Studio is served from smith.langchain.com and needs a LangSmith account and API key. See [Studio](https://docs.langchain.com/oss/javascript/langgraph/studio) and [Local server](https://docs.langchain.com/oss/javascript/langgraph/local-server).
[^m-licence]: Code in `ee/` folders is under the Mastra Enterprise Edition licence. It is source-available, not open source. See [LICENSE.md](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md).

## What the rows mean

- **Runs in your own process**: a library you call from your own Node process.
  No hosted runtime is needed.
- **Durable resume after a crash**: a run that dies part way through can carry
  on from a checkpoint, without redoing work that already finished.
- **Human approval with pause/resume across processes**: a tool call can wait
  for a person, the wait can be saved, and another process can finish the run.
- **Offline record/replay evals**: record a real run once, replay it in CI with
  no network and no API key, and flag when the tool-call trajectory changes.
- **MCP client / MCP server**: call tools from MCP servers, or serve your agent
  as one.
- **React/Vue/Svelte bindings**: first-party UI hooks or stores for those
  frameworks.
- **OpenTelemetry**: spans you can send to any OpenTelemetry backend.
- **Local studio/debugger**: a UI on your machine to inspect and run agents.
- **Provider-agnostic**: works with models from more than one vendor.

## When not to use Lousho

- **You need Python.** Lousho is TypeScript only. It needs Node 22.19 or later.
- **You want a managed platform.** Lousho has no hosted runtime. You run and
  host the agent, its store and the studio yourself.
- **You need a stable 1.0 API today.** Lousho is in alpha (`1.0.0-alpha.*`).
  The API may change before 1.0, so pin a version. See
  [Upgrading to 1.0](./upgrading.md).
- **You only need one model call or a simple tool loop.** The Vercel AI SDK on
  its own is smaller. Lousho builds on it, so you can move over later. See
  [Migrating from the AI SDK](./migrating-from-ai-sdk.md).
