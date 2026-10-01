| LOU-D13 ✅ [#47](https://github.com/LinuxDevil/agent-sdk/pull/47) || LOU-D12 ✅ [#51](https://github.com/LinuxDevil/agent-sdk/pull/51) || LOU-D1 ✅ [#50](https://github.com/LinuxDevil/agent-sdk/pull/50) || LOU-Z3 ✅ [#52](https://github.com/LinuxDevil/agent-sdk/pull/52) || LOU-Z2 ✅ [#46](https://github.com/LinuxDevil/agent-sdk/pull/46) || LOU-Z1 ✅ [#46](https://github.com/LinuxDevil/agent-sdk/pull/46) || LOU-Y2 ✅ [#44](https://github.com/LinuxDevil/agent-sdk/pull/44) || LOU-X7 ✅ [#55](https://github.com/LinuxDevil/agent-sdk/pull/55) || LOU-W1 ✅ [#45](https://github.com/LinuxDevil/agent-sdk/pull/45) || LOU-V3 ✅ [#49](https://github.com/LinuxDevil/agent-sdk/pull/49) || LOU-U18 ✅ || LOU-U16 ✅ [#48](https://github.com/LinuxDevil/agent-sdk/pull/48) || LOU-U13 ✅ [#48](https://github.com/LinuxDevil/agent-sdk/pull/48) || LOU-D5 ✅ [#40](https://github.com/LinuxDevil/agent-sdk/pull/40) || LOU-X1 ✅ [#39](https://github.com/LinuxDevil/agent-sdk/pull/39) || LOU-V1 ✅ [#42](https://github.com/LinuxDevil/agent-sdk/pull/42) || LOU-U11 ✅ [#35](https://github.com/LinuxDevil/agent-sdk/pull/35) || LOU-U10 ✅ [#35](https://github.com/LinuxDevil/agent-sdk/pull/35) || LOU-U6 ✅ [#36](https://github.com/LinuxDevil/agent-sdk/pull/36) || LOU-U5 ✅ [#36](https://github.com/LinuxDevil/agent-sdk/pull/36) || LOU-U4 ✅ [#32](https://github.com/LinuxDevil/agent-sdk/pull/32) || LOU-U3 ✅ [#34](https://github.com/LinuxDevil/agent-sdk/pull/34) || LOU-U2 ✅ [#33](https://github.com/LinuxDevil/agent-sdk/pull/33) || LOU-U1 ✅ [#31](https://github.com/LinuxDevil/agent-sdk/pull/31) |# Roadmap: beat eve and open-harness

Sources: [feature audit](../research/feature-audit.md) and
[competitor research](../research/competitors-eve-open-harness.md).

Every ticket is **1 story point**: one PR, independently mergeable, with tests.
Tickets are ordered by priority inside each epic; epics are ordered by priority.
Status: a ✅ with a PR link next to the ID means merged.

## Epic U — Correctness (bugs found by the audit)

| ID | Ticket | Acceptance |
|---|---|---|
| LOU-U1 | Honor the configured model | `resolveProvider('openai/gpt-4o-mini')` and `spec.provider.model` reach `provider.generate()`; no hard-coded `gpt-4` fallback; test per provider type. |
| LOU-U2 | Keep assistant tool-call turns in provider message conversion | OpenAI, Anthropic and Ollama converters emit the assistant tool-call message and the matching tool-result message; contract test asserts the wire payload for a two-step tool conversation. |
| LOU-U3 | Remove `eval()` from `FlowExecutor` | Conditions are evaluated by a safe expression evaluator (no `eval`/`Function`); injection test proves arbitrary code does not run; existing flow tests pass. |
| LOU-U4 | Validate tool arguments against the tool schema | Invalid args never reach `execute`; the model receives a structured validation error it can correct; test covers retry-after-correction. |
| LOU-U5 | README and docs accuracy | `resumeAfterApproval` argument order and the `FlowBuilder` example match the code; `docs:verify-snippets` also type-checks README snippets. |
| LOU-U6 | Correct `engines` and Node support | `engines.node` matches what dependencies need (or `undici` is loaded lazily so Node 20 works); CI matrix matches. |
| LOU-U7 | Approval in the middle of a tool batch keeps the transcript valid | When one of several tool calls needs approval, completed results and pending calls are checkpointed so the resumed transcript has a result for every call. |
| LOU-U8 | Resume accepts new user input | A resumed session appends the new input rather than dropping it; test. |
| LOU-U9 | Checkpoint after every LLM turn | A crash after a model response (before tools run) resumes without re-calling the model; test with a failing store/provider. |
| LOU-U10 | Fix Agent Forge `stop()` then `run()` resume test | `server/__tests__/runRegistry.test.ts > stop() then run() resumes from the last checkpoint` fails on `main` (times out waiting for status); find the root cause and fix it. |
| LOU-U11 | CI runs the Agent Forge unit and server suites | `ci.yml` runs `apps/agent-forge` typechecks, `vitest run` and `test:server`, so regressions like LOU-U10 cannot land silently. |
| LOU-U12 ✅ [#37](https://github.com/LinuxDevil/agent-sdk/pull/37) | A thrown tool error reaches the model as a structured error | The model sees `{ error, toolName, message }` instead of `"null"`; message capped; propagating errors still abort. |
| LOU-U13 | Bind flow `{{var}}` placeholders as values | Placeholders in flow conditions are bound as values, not spliced in as text, so a variable containing quotes cannot change a condition's logic. |
| LOU-U14 | One tool-error shape everywhere | `resume.ts` (tool run after approval), "tool not found" and "no registry" failures use the same `{ error, toolName, message }` shape and `isError` flag as the main loop. |
| LOU-U15 | Tool `execute` context is real at runtime | The second argument typed as tool execution options is always populated (`toolCallId`, `messages`, `abortSignal`), including on the sandbox path, which passes `{}` today. |
| LOU-U16 | Flow and adapter types match the runtime | `EditorStep`/flow node types cover what `FlowExecutor` runs (`llmCall`, `oneOf` with `options`, ...); real `node:fs` is assignable to `FileSystemAdapter`; README casts removed. |
| LOU-U17 | Sandboxed HTTP honors cancellation | `sandboxHttpFetch` accepts and forwards the abort signal. |
| LOU-U18 | Type tests in CI | `npm run test:types` runs in `ci.yml`. |

## Epic V — Run loop

| ID | Ticket | Acceptance |
|---|---|---|
| LOU-V1 | Cancellation | `signal: AbortSignal` on `execute`/`send` aborts the provider call and running tools; result has `finishReason: 'aborted'`; partial transcript is checkpointed. |
| LOU-V2 | Typed event stream | `agent.stream(input)` returns an async iterable of versioned, typed events (`text.delta`, `tool.start`, `tool.done`, `tool.error`, `step.start`, `step.done`, `approval.requested`, `done`); documented schema. |
| LOU-V3 | Parallel tool calls | Tool calls in one model turn run concurrently (configurable `toolConcurrency`, default parallel); results keep call order; approvals still gate per call. |
| LOU-V4 | Structured output | `output: zodSchema` yields a typed, validated `result.object` with one automatic repair attempt on validation failure. |
| LOU-V5 | Usage and cost accounting | Every result and `done` event carries input/output tokens and estimated USD from a price table that users can override. |
| LOU-V6 | Budgets | `limits: { maxTokens, maxCostUsd, maxDurationMs, maxSteps }` stop the run with `finishReason: 'budget-exceeded'` and a typed `BudgetExceededError` detail. |
| LOU-V7 | Retry policy and model fallback | `retry: { maxRetries, backoff }` and `fallbackModels: [...]` on the agent; retries emit `retry` events; test with a flaky mock. |

## Epic W — Context and memory

| ID | Ticket | Acceptance |
|---|---|---|
| LOU-W1 | Token estimation and context-window registry | `estimateTokens(messages)` and a per-model context window table; used by compaction and budgets. |
| LOU-W2 | Compaction: prune old tool results | When context passes a threshold, old tool results are replaced by a marker while recent tokens are protected; emits `compaction.*` events with before/after token counts. |
| LOU-W3 | Compaction: summarize strategy and pluggable interface | `CompactionStrategy` interface; built-in summarize strategy using a (cheaper) model; pinned messages are never compacted. |
| LOU-W4 | Sessions | `agent.session(id, { store })` persists the thread across `send` calls and processes; in-memory and file stores. |
| LOU-W5 | SQLite store | One SQLite-backed store for sessions, checkpoints and approvals (`node:sqlite`), behind the existing store interfaces. |
| LOU-W6 | Scoped memory slots | `defineMemory({ scope, provider })` with recall on session start and `remember`/`recall` tools; file provider built in. |
| LOU-W7 | AGENTS.md auto-loading | Nearest `AGENTS.md`/`CLAUDE.md` is prepended to instructions; opt out with `instructions: { autoLoad: false }`. |

## Epic X — Tools, permissions, hooks

| ID | Ticket | Acceptance |
|---|---|---|
| LOU-X1 | `defineTool` with inferred types | `defineTool({ name, description, input: z.object(...), execute })` infers `execute` argument types; accepted everywhere a `ToolDescriptor` is. |
| LOU-X2 | Permission policies | Declarative `permissions: [{ tool, when, action: 'allow' \| 'deny' \| 'ask' }]` evaluated before `needsApproval`; every decision goes to an audit log sink. |
| LOU-X3 | Hook outcomes | Hooks can return `deny` (with a message to the model), `replace` (result) or `modify` (args) instead of only throwing. |
| LOU-X4 | Input and output guardrails | `guardrails: { input: [...], output: [...] }` on any agent; a tripped guardrail yields `finishReason: 'guardrail'`. |
| LOU-X5 | Enforce `spec.policy` | The policy block of an `AgentSpec` is compiled into permissions/limits at `specToAgent` time; test. |
| LOU-X6 | Workspace tools | `createFsTools(provider)` and `createShellTool(provider)` over `FsProvider`/`ShellProvider` interfaces, with Node and sandbox providers. |
| LOU-X7 | Todo tools | Built-in `todo_write`/`todo_read` tools with a typed `todos` event. |

## Epic Y — Sub-agents and skills

| ID | Ticket | Acceptance |
|---|---|---|
| LOU-Y1 | Delegation inherits the parent runtime | Child agents get the parent's hooks, tracing context, approval store and abort signal. |
| LOU-Y2 | Skills | `SKILL.md` (frontmatter + body) loader, a `skills` option, and an auto-registered `load_skill` tool; only descriptions are in the prompt until loaded. |
| LOU-Y3 | `task` tool and sub-agent catalog | `subagents: { name: agent }` registers a `task` tool; `maxSubagentDepth`; isolated context; result summary returned to the parent. |
| LOU-Y4 | Background sub-agents | `task` supports `background: true` with `agent_status`/`agent_await`/`agent_cancel` tools and `maxConcurrent`. |
| LOU-Y5 | Filesystem agent loader | `loadAgentDir('agent/')` maps `instructions.md`, `tools/*.ts`, `skills/*.md`, `subagents/*/` to the same objects the code API builds. |

## Epic Z — MCP

| ID | Ticket | Acceptance |
|---|---|---|
| LOU-Z1 | Robust MCP schema conversion | `anyOf`, `oneOf`, `$ref` and nullable schemas convert; one bad tool is skipped with a warning instead of failing the server load. |
| LOU-Z2 | MCP `isError` and content handling | `isError` results surface as tool errors; image/resource content is preserved. |
| LOU-Z3 | Agent as an MCP server | `serveMcp(agent)` (stdio and HTTP) exposes the agent as a tool; `loushy mcp <config>`. |

## Epic D — DX, CLI, packaging, testing

| ID | Ticket | Acceptance |
|---|---|---|
| LOU-D1 | Five-line hello world | `createAgent({ model: 'openai/gpt-4o-mini', instructions })` accepts a model string and reads the key from env; README leads with it. |
| LOU-D2 | Error codes with fixes | Every thrown SDK error has a stable `code`, a "how to fix" hint and a docs link; spec validation suggests "did you mean". |
| LOU-D3 | `loushy init` | Scaffolds a runnable project from the published package (no sibling checkout needed); wraps `create-loushy-agent`. |
| LOU-D4 | `loushy doctor` | Reports Node version, installed peers, missing API keys and config problems with fixes. |
| LOU-D5 | Scripted mock model | `mockModel([...turns])` at `/testing` for deterministic agent tests (text, tool calls, errors, usage). |
| LOU-D6 | Record/replay provider | `recordReplay(provider, { cassette })` records real calls once and replays them in CI. |
| LOU-D7 | Trajectory evals | `defineEval` gains `t.calledTool()`, `t.completed()`, multiple named scores, datasets, gate vs soft assertions. |
| LOU-D8 | `loushy eval` | Runs evals with a summary table, `--junit` output and non-zero exit on gate failures. |
| LOU-D9 | OTel GenAI conventions | Spans use `gen_ai.*` attribute names; flows are traced. |
| LOU-D10 | Lazy provider loading | Importing the root entry does not load any provider SDK; providers load on first use. |
| LOU-D11 | Upgrade the `ai` peer range | Providers work against the current major of `ai`/`@ai-sdk/*`; peer ranges widened; contract tests pass. |
| LOU-D12 | Agent-readable docs | `llms.txt` and `llms-full.txt` generated from `docs/` and shipped in the npm package. |
| LOU-D13 | Trigger hardening | Webhook HMAC verification; real cron expressions in `CronTriggerAdapter`. |
| LOU-D14 | Deployed `/chat` upgrade | Multi-turn sessions, SSE streaming and bearer auth in the node-server and worker targets. |
| LOU-D15 | React hook | `useLoushyAgent()` consuming the typed event stream. |
| LOU-D16 | ESLint ratchet | Clear the remaining warnings in touched areas and turn `no-explicit-any`/`no-unused-vars` back to `error`; delete the stale baseline doc. |
| LOU-D17 | Slack signature verification ✅ [#55](https://github.com/LinuxDevil/agent-sdk/pull/55) | (was LOU-D18) Inbound Slack requests are verified with the signing secret. |
| LOU-D19 | Lazy optional peers | A missing optional provider peer never fails at SDK import time; the install hint appears when that provider is first used. (Merge with LOU-D10.) |
| LOU-D20 | `mcpServers` in `AgentSpec` | MCP servers are a first-class, validated spec field (doctor reads them from the raw file today). |
| LOU-D21 | Approvals for `createAgent()` agents | The zero-config agent can pause for approval and resume (`approvalStore` option / in-memory default), instead of failing with "requires approval". |

## Not ticketed (needs the owner)

- Publishing to npm: the README advertises `npm install @loushy/build-ai-agent`, but the package is not on the registry. Publishing is an owner action.
