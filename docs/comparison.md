# Comparison with other agent frameworks

This page is a short, factual orientation, not a benchmark. Competing projects
move fast, so the rows about them describe their general shape; check their own
documentation before deciding. The rows about lousho describe this repository.

## Where each one fits

| Project | Where it fits best |
| ------- | ------------------ |
| lousho (`@lousho/build-ai-agent`) | TypeScript agents that need durable human approvals, record/replay tests and trajectory evals, and coding-agent tooling, on top of providers you pick. |
| [Vercel AI SDK](https://ai-sdk.dev) (`ToolLoopAgent`, `WorkflowAgent`) | The model and UI layer for TypeScript apps, with the largest provider and framework ecosystem. lousho uses it underneath for the standard providers. |
| [Mastra](https://mastra.ai) | A full-stack TypeScript framework: agents, workflows, memory, RAG and a hosted/dev UI in one package. |
| [OpenAI Agents SDK (JS)](https://openai.github.io/openai-agents-js/) | Agents built around OpenAI's APIs: handoffs, guardrails and tracing, with first-class access to OpenAI hosted tools. |
| [Vercel eve](https://vercel.com) | Agents deployed on Vercel's platform. Platform-coupled by design. |
| [LangGraph.js](https://langchain-ai.github.io/langgraphjs/) | Explicit graph-shaped, stateful workflows with checkpointing, when you want to draw the control flow yourself. |

## Capabilities at a glance

"Yes" for lousho is checkable in this repository. For the others the column
says what the project is generally used for, not an exhaustive feature list.

| Capability | lousho | Others |
| ---------- | ------ | ------ |
| Durable tool approvals that survive a restart | Yes, vendor-neutral: `needsApproval`, `resumeAfterApproval()`, memory, file, SQLite and Cloudflare KV stores ([Approvals](./approvals.md), [Durable execution](./durable-execution.md)) | Varies; most offer human-in-the-loop in some form, usually tied to their own runtime or store |
| Record/replay test cassettes | Yes ([Testing](./testing.md#record-and-replay)) | Mock models are common; check each for recorded-response replay |
| Trajectory evals in CI | Yes: `lousho eval` asserts tool order and arguments, with JUnit output ([Evals](./evals.md)) | Varies |
| Coding-agent tooling | Workspace tools with checkpoint rewind, permission rules, loop guard, `piAgent()`, registry kits ([Build a coding agent](./build-a-coding-agent.md)) | Mostly build it yourself |
| UI bindings | React, Vue and Svelte ([React](./react.md), [Vue](./vue.md), [Svelte](./svelte.md)) | The AI SDK has the broadest UI support |
| Any provider | OpenAI, Anthropic, OpenRouter, Ollama, Pi catalog, custom | The AI SDK has the most providers; the OpenAI Agents SDK centres on OpenAI |

## Where lousho is weaker

- **One maintainer, alpha releases.** The 1.0 line is still `1.0.0-alpha.*`. Expect API churn, a small community and few third-party integrations compared with the established projects.
- **No Postgres store.** Checkpoint and approval stores ship for memory, file, SQLite and Cloudflare KV. For Postgres you implement the small `CheckpointStore` / `ApprovalStore` interfaces yourself.
- **The root entry point is not edge-safe.** Cloudflare Workers use the dedicated `worker` build and subpaths ([Cloudflare Workers](./cloudflare-workers.md)); importing the root package in an edge runtime is not supported.
- **Smaller ecosystem.** Fewer ready-made connectors, templates and tutorials than the AI SDK or LangGraph.
- **Live runs are manual.** CI runs offline tests and cassette replays; live-provider checks are run by hand.

## Where lousho is stronger

- **Approvals that outlive the process**, with the same behaviour across four store backends rather than one tied to a single platform.
- **Tests you can run offline**: record a real model run once, replay it in CI, and assert on tool-call trajectories.
- **Coding agents as a first-class use case**: agent directories, kits you `lousho add`, checkpoints and permission rules.
- **Vendor-neutral**: the same agent runs on any provider, and the same approvals code on any store.
- **Frontend bindings** for React, Vue and Svelte over one stream protocol.

If you only need a model call with streaming UI, the Vercel AI SDK alone is the
simpler choice. If you want an all-in-one framework with a hosted UI, look at
Mastra. If your control flow is a graph, look at LangGraph.js.
