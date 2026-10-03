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
| LOU-Z3 | Agent as an MCP server | `serveMcp(agent)` (stdio and HTTP) exposes the agent as a tool; `lousho mcp <config>`. |

## Epic D — DX, CLI, packaging, testing

| ID | Ticket | Acceptance |
|---|---|---|
| LOU-D1 | Five-line hello world | `createAgent({ model: 'openai/gpt-4o-mini', instructions })` accepts a model string and reads the key from env; README leads with it. |
| LOU-D2 | Error codes with fixes | Every thrown SDK error has a stable `code`, a "how to fix" hint and a docs link; spec validation suggests "did you mean". |
| LOU-D3 | `lousho init` | Scaffolds a runnable project from the published package (no sibling checkout needed); wraps `create-lousho-agent`. |
| LOU-D4 | `lousho doctor` | Reports Node version, installed peers, missing API keys and config problems with fixes. |
| LOU-D5 | Scripted mock model | `mockModel([...turns])` at `/testing` for deterministic agent tests (text, tool calls, errors, usage). |
| LOU-D6 | Record/replay provider | `recordReplay(provider, { cassette })` records real calls once and replays them in CI. |
| LOU-D7 | Trajectory evals | `defineEval` gains `t.calledTool()`, `t.completed()`, multiple named scores, datasets, gate vs soft assertions. |
| LOU-D8 | `lousho eval` | Runs evals with a summary table, `--junit` output and non-zero exit on gate failures. |
| LOU-D9 | OTel GenAI conventions | Spans use `gen_ai.*` attribute names; flows are traced. |
| LOU-D10 | Lazy provider loading | Importing the root entry does not load any provider SDK; providers load on first use. |
| LOU-D11 | Upgrade the `ai` peer range | Providers work against the current major of `ai`/`@ai-sdk/*`; peer ranges widened; contract tests pass. |
| LOU-D12 | Agent-readable docs | `llms.txt` and `llms-full.txt` generated from `docs/` and shipped in the npm package. |
| LOU-D13 | Trigger hardening | Webhook HMAC verification; real cron expressions in `CronTriggerAdapter`. |
| LOU-D14 | Deployed `/chat` upgrade | Multi-turn sessions, SSE streaming and bearer auth in the node-server and worker targets. |
| LOU-D15 | React hook | `useLoushoAgent()` consuming the typed event stream. |
| LOU-D16 | ESLint ratchet | Clear the remaining warnings in touched areas and turn `no-explicit-any`/`no-unused-vars` back to `error`; delete the stale baseline doc. |

| LOU-D17 | Slack signature verification ✅ [#55](https://github.com/LinuxDevil/agent-sdk/pull/55) | (was LOU-D18) Inbound Slack requests are verified with the signing secret. |
| LOU-D19 | Lazy optional peers | A missing optional provider peer never fails at SDK import time; the install hint appears when that provider is first used. (Merge with LOU-D10.) |
| LOU-D20 | `mcpServers` in `AgentSpec` | MCP servers are a first-class, validated spec field (doctor reads them from the raw file today). |
| LOU-D21 | Approvals for `createAgent()` agents | The zero-config agent can pause for approval and resume (`approvalStore` option / in-memory default), instead of failing with "requires approval". |

## Epic R — Docs-vs-reality round 2

Sources: the 2026-10-03 live docs audit (`docs-audit-report.html`, 386 pass / 42 fail
against OpenRouter) and the parallel static verification session. Acceptance for
doc tickets: `npm run docs:verify-snippets -- --skip-build` stays green and the
claim matches runtime behavior. `⚠` = decision needed before implementation.

| ID | Ticket | Acceptance |
|---|---|---|
| LOU-R1 ✅ [#360](https://github.com/LinuxDevil/agent-sdk/pull/360) | Lazy provider registration | `LLMProviderRegistry.create`/`resolveProvider` self-registers known providers instead of relying on the `src/index.ts` side-effect; `lousho dev/chat/acp`, deploy bundles and `resolveProvider` deep imports resolve `openrouter` etc. without importing the root barrel; reconcile with LOU-D10/D19. |
| LOU-R2 ✅ [#348](https://github.com/LinuxDevil/agent-sdk/pull/348) | `secretScanGuardrail` must not leak the matched secret | Rejection reason reports the pattern label only; regression test asserts the matched text appears in no reason/event (`src/execution/guardrails.ts:222`). |
| LOU-R3 ✅ [#352](https://github.com/LinuxDevil/agent-sdk/pull/352) | `createAgent` forwards `redactContent` | Prompts/tool IO are redacted from spans and `.lousho/traces` when set via `createAgent`; `gen_ai.input.messages` is not double-encoded on `invoke_agent` spans. |
| LOU-R4 ✅ [#349](https://github.com/LinuxDevil/agent-sdk/pull/349) | Plain JSON-Schema tool params work on `ai` 4 | `v4Parameters` wraps non-zod/standard-schema objects in `ai.jsonSchema()`; the `examples/openrouter` `tools` snippet runs without the `typeName` TypeError. |
| LOU-R5 ✅ [#353](https://github.com/LinuxDevil/agent-sdk/pull/353) | Provider error bodies reach the caller | A 401/404 from OpenRouter surfaces the response-body message instead of `""`/bare "Not Found"; `examples/openrouter` `errors` matcher still classifies correctly (case-insensitive). |
| LOU-R6 ✅ [#356](https://github.com/LinuxDevil/agent-sdk/pull/356) | `stream()` honors retry and fallbacks | `retry`, `fallbackModels`, `withRetry`, `withFallback` apply to `agent.stream()` (provider-call errors, not only iteration errors); `provider.fallback` events fire; test with a flaky mock. |
| LOU-R7 ✅ [#358](https://github.com/LinuxDevil/agent-sdk/pull/358) | Strict structured-output schemas | `output: z.object(...)` sends `additionalProperties:false` (recursively) where the provider requires it; works on `ai` 7 + zod 4 without `z.strictObject`; repair path unchanged. |
| LOU-R8 ✅ [#362](https://github.com/LinuxDevil/agent-sdk/pull/362) | OpenRouter reasoning is surfaced | Provider-returned reasoning emits `reasoning.*` stream events and fills `result.reasoning`; live check on a reasoning-capable model. |
| LOU-R9 ✅ [#351](https://github.com/LinuxDevil/agent-sdk/pull/351) | `LocalStorageCheckpointStore` works on a fresh directory | First `save()` creates `checkpoints/` and `checkpoint-history/`; no `ENOENT` on `*.lock`. |
| LOU-R10 ✅ [#354](https://github.com/LinuxDevil/agent-sdk/pull/354) | `recordReplay` is ESM-safe | No `__dirname` ReferenceError in the `.mjs` build (`src/testing/cassette.ts:183`); `--replay` mode does not require an API key. |
| LOU-R11 ✅ [#357](https://github.com/LinuxDevil/agent-sdk/pull/357) | Compaction never grows context or loops | A summarizer result ≥ input tokens is rejected (fallback to prune or keep); a run cannot hit `max-steps` from re-summarizing every step; test with an adversarial summarizer. |
| LOU-R12 ✅ [#365](https://github.com/LinuxDevil/agent-sdk/pull/365) | `createAgent.tools` accepts mixed record + array | `[...Object.values(mcp.tools), weatherTool]` (or equivalent mixing) works; normalize to one shape internally; test MCP-record + array combination. |
| LOU-R13 ✅ [#361](https://github.com/LinuxDevil/agent-sdk/pull/361) | Cassette errors keep their type | A mismatch through `agent.send()` rejects as `CassetteMismatchError` (or a documented single wrapper), not `CompactedLLMProviderError`; `setProviderInterceptor` is exported from a public entry. |
| LOU-R14 ✅ [#364](https://github.com/LinuxDevil/agent-sdk/pull/364) | `FlowExecutor` handles `createAgent` agents | Either runs them (keeping instructions) or rejects with a coded error; no silent instruction drop. |
| LOU-R15 ✅ [#373](https://github.com/LinuxDevil/agent-sdk/pull/373) | Schedule session ids are server-legal | Rename schedule sessions to `schedule-<name>` (decided: keep the strict `^[A-Za-z0-9_-]{1,128}$` regex); `GET /chat/<scheduled-session>` works. |
| LOU-R16 ✅ [#368](https://github.com/LinuxDevil/agent-sdk/pull/368) | Hook context `metadata` is populated | `send(x, { metadata })` reaches `ctx.metadata` in hooks (decided: wire it through — the field is already typed). |
| LOU-R17 ✅ [#370](https://github.com/LinuxDevil/agent-sdk/pull/370) | `tool.start` emits once around approvals | Decided: fix the code — no re-fire after approval (or a distinct resume event); `build-a-coding-agent.md:134` then matches behavior. |
| LOU-R18 ✅ [#371](https://github.com/LinuxDevil/agent-sdk/pull/371) | Turn events reach `session.on()` listeners | Decided: fix the code — permission-mode switches (and other turn events) work from `session.on()` listeners, not only `onEvent`/`stream()` loops. |
| LOU-R19 ✅ [#367](https://github.com/LinuxDevil/agent-sdk/pull/367) | `lousho` CLI surface | `--traces` on a module-exported agent writes trace files; missing `.yaml` path throws a coded error (not raw `ENOENT`); `lousho add --dry-run` exits 0 when the target exists; top-level `--help` matches implemented commands/flags. |
| LOU-R20 ✅ [#369](https://github.com/LinuxDevil/agent-sdk/pull/369) | Deploy targets carry dependencies | `lousho build --target=docker` emits a `package.json` with the provider peers needed by the bundle; image installs them. |
| LOU-R21 ✅ [#372](https://github.com/LinuxDevil/agent-sdk/pull/372) | Examples run as documented | `ops-pipeline` invokes `startOpsPipeline()` when run directly; `openrouter` model ids are current + provider config used in `agent-builder`; `plan-mode`/`agent-dir` import via the package barrel; all `npm run` scripts exit 0; live snippets verified (~$0.05 budget). |
| LOU-R22 ✅ [#350](https://github.com/LinuxDevil/agent-sdk/pull/350) | Docs: provider-prefix note | One sentence on every provider-sensitive page: "the `vendor/` model prefix chooses the provider; with OpenRouter use `openrouter/<vendor>/<model>`"; refresh stale ids (`gemini-2.0-flash`, `claude-3-5-*-latest`, `hosted-tools.md` headline). |
| LOU-R23 ✅ [#363](https://github.com/LinuxDevil/agent-sdk/pull/363) | Docs: errors + troubleshooting + testing | `errors.md` (SDKError universality, `webhookTrigger`, code-index auth section, `LOUSHO_CASSETTE_INVALID` scope), `troubleshooting.md` (PDF/files claim vs `providers.md:132`, conditional retry defaults, MCP `needs-auth` status), `testing.md` (`temperature` on `createAgent`, usage semantics, recordReplay caveats resolved by LOU-R10). |
| LOU-R24 ✅ [#355](https://github.com/LinuxDevil/agent-sdk/pull/355) | Docs: event schema | `stream-events.md` gains `agent.drift`, `executedBy`, `replacedByHook`, `hook`, `trigger`, and full `usage` fields (`costUsd`, `modelCalls`, ...); `runs.md` drops deprecated `tool-call`/`tool-result`/`finish` names; "every event inside a step" gets the post-approval caveat. |
| LOU-R25 ✅ [#359](https://github.com/LinuxDevil/agent-sdk/pull/359) | Docs: UI + servers | `ai-sdk-ui.md` uses `DefaultChatTransport`; `ai-sdk-ui.md`/`nextjs.md` server examples pass a `store` so sessions persist; React/Vue/Svelte version caveats. `⚠` (depends on `ai` v5 peer-range decision) |
| LOU-R26 ✅ [#366](https://github.com/LinuxDevil/agent-sdk/pull/366) | Docs: long-tail corrections | cli.md (eval `--config`, `init`/`InitUsageError`, `.cts`, streamed approval continuations), sub-agents.md (`lousho deploy`→`build`, unexported `serveFetch`), agent-directories.md (`description`, `createDeployedServer`), cloudflare-workers.md (`tool.done`, `/deploy-runtime-worker` subpath, `handleScheduled` checkpoint store), schedules/sessions folder layout, utilities.md (`saveAttachment` Node form, `readAttachment` → `ArrayBuffer`), oauth.md (256-bit state), memory.md (`<name>`), tools.md (`ctx.sessionId`), flows.md (`throw` node), registry.md (name start char + full static-check list), configuration.md (`triggers`), approvals `when` ctx `principal`, workspace-tools.md (`'not-a-file'`), channels name→route, evals.md `completed()` message, `formatUsage` sub-cent, fallback event field names, durable-execution `divergedAt`, hooks.md `HookRegistry.size()`, permission-modes/`session.on()` scope (per LOU-R18), wildcard `*.example.com` vs bare host, `NodeWorkspace` missing root. |

Decisions recorded (owner, 2026-10): R15 rename to `schedule-<name>`; R16 wire
`metadata` through; R17+R18 fix the code (not docs); R25 document v4/v6/v7 only —
the `ai` peer range stays as-is.

| LOU-R27 | Break the provider import cycle + source-barrel ESM edge | LOU-R1 made llm.ts <-> builtinProviders.ts circular (fallow flags it on every post-R1 PR). Also: static named imports from the source barrel fail under true ESM (.mts via tsx) - e.g. import { createAgent } from ./src/index throws does not provide an export named. Bundled dist and CJS-transformed .ts importers are unaffected; fix by inverting the llm.ts -> builtinProviders.ts edge or splitting the registry table. |

| LOU-R28 ✅ [#377](https://github.com/LinuxDevil/agent-sdk/pull/377) | errors.md: cassette error type + uncoded-error list | CassetteMismatchError is a coded SDKError (LOUSHO_CASSETTE_INVALID) since LOU-R13, not a plain Error; move it out of the 'no code' paragraph. Add WorkspaceError, AuthError, McpToolError to the uncoded list. |
| LOU-R29 ✅ [#378](https://github.com/LinuxDevil/agent-sdk/pull/378) | Stale-residue mediums across docs | cloudflare-workers.md:211 + tools.md:327: continuation emits tool.resume not a new tool.start. executor-api.md + quick-start.md: exporter/captureContent are createAgent() options. providers.md: claude-sonnet-5 -> claude-sonnet-5-5. api-overview.md + README: subagents also register agent_status/agent_await/agent_cancel. README: agent.resume() throws on approval-paused runs; Agent Forge shows saved traces; file parts sent on ai>=6. |
| LOU-R30 ✅ [#379](https://github.com/LinuxDevil/agent-sdk/pull/379) | Docs long-tail lows + stale code comments | SQLite Node >=22.13.0; cron shortcuts @midnight/@yearly/@annually; lousho traces in CLI lists (installation.md, README); sub-agents principal/metadata rows; nextjs /oauth/callback route; react.md nits; tools denied/.tool/providedArguments; sessions queue edge; providers fallback phrasing; agent-dir extensions (.mts/.cts/.mjs/.cjs/.yml); RunConfigContext.principal; async approve; ExecutionResult fields; remoteAgent.ts 'lousho deploy' JSDoc; kvTokenStore.ts '128+ bits' comment; regenerate llms.txt/llms-full.txt. |

## Not ticketed (needs the owner)

- Publishing to npm: the README advertises `npm install @lousho/build-ai-agent`, but the package is not on the registry. Publishing is an owner action.
