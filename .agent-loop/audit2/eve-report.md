# eve re-audit (refresh of AUDIT.md sections 1, 2, 6, 7)

Date 2026-10-02. Read-only on code. Clone: `scratchpad/audit2/eve` (`git clone --depth 200 https://github.com/vercel/eve`). All paths below are relative to that clone unless they start with a drive letter.

Legend: **[V]** = verified by reading the cited file at the new HEAD. **[I]** = inferred (reason given). "Not found" = grep of `docs/**` (121 files, same count as the old audit) and, where stated, `packages/eve/src`.

## 1. Version and commit

| Item | Value | Status |
|---|---|---|
| npm latest | `eve` **0.70.0**, published 2026-10-02T01:32:33Z (`npm view eve version time --json`). Previous: 0.69.0 at 2026-10-01T01:38:37Z | [V] |
| HEAD | `dd50d12da445aa57f52ec1702a396aa9df99e451`, 2026-10-01 23:48:58 -0400 (= 2026-10-02 03:48 UTC), "fix(web): show user-message links and pending approvals in scaffolded web chat (#4184)" | [V] |
| Old audited commit | `682c7a68f22fbae52e3102718534ece8fc36f9a1`, 2026-10-01 01:26:52 UTC (present in the shallow history) | [V] |
| Distance | 23 commits `682c7a6..HEAD`; 468 files changed, +20,473 / -18,749; docs: 20 files, +259 / -138 | [V] `git log`, `git diff --stat` |
| Release commit | `6181372` "Version Packages (#4116)", 2026-10-02 01:18 UTC, sets `packages/eve/package.json` to 0.70.0. HEAD is 3 commits past it (unreleased: `c05a0aa` docs, `dc50f62` perf, `dd50d12` web chat fix; pending changesets `.changeset/faster-hosted-bundle.md`, `.changeset/web-chat-render-fixes.md`) | [V]; that the npm tarball equals `6181372` is [I] from timestamps |
| Release cadence | 38 versions between 0.52.1 (2026-09-04) and 0.70.0 (2026-10-02); roughly one minor per working day | [V] npm `time` |
| Node | `engines.node: ">=24"` (`packages/eve/package.json:636`) | [V] |
| `ai` peer | `ai: "catalog:"` -> `^7.0.105` (`pnpm-workspace.yaml:50`); zod catalog `4.5.4`; `@workflow/world-postgres 5.0.0-beta.47` | [V] |
| Hard deps | `nitro`, `undici` only; optional peers `@opentelemetry/api`, `braintrust`, `chat`, `dd-trace`, `just-bash`, `microsandbox` | [V] `packages/eve/package.json` |
| Public entry points | 87 export subpaths (`packages/eve/package.json` `exports`) | [V] |
| Other packages in repo | `@eve/buzz-acp-adapter` 0.0.41 (public), `@eve/catalog` 0.0.1, `@eve/code`, `@eve/computer-use`, `@eve/self-modification` (private, shipped inside `eve`) | [V] `packages/*/package.json` |

## 2. Changes since 682c7a6

Source: `packages/eve/CHANGELOG.md` section `## 0.70.0` (all [V]) plus `git log 682c7a6..HEAD`.

### Breaking (marked `!` in commits or stated as behavior changes)

| Commit | Change |
|---|---|
| `ddc8e12` feat(eve)! | **Tool approval and connection sign-in now hold the turn open.** Stream emits `turn.waiting` (not `turn.completed` + `session.waiting`); the same `turnId` resumes after the person acts. Every `turn.waiting` now carries `on: "input" \| "tasks"`. A message from the person the turn serves **steers the turn and cancels the pending approval/sign-in** (`input.resolved` `outcome: "ignored"`), even under `turnPolicy: "queue"`; cancelling the turn withdraws the approval. Docs: `docs/tools/human-in-the-loop.md:12,215,229`. The old audit's description of eve approvals as "durable pause" still holds, but the event contract changed. |
| `63f86de` feat(eve)! | TUI `--logs` / `/loglevel` modes are now `none`, `error` (default), `warn`, `debug`, `all`; `stderr` and `sandbox` filters removed (`docs/reference/cli.md:279`, `docs/guides/dev-tui.md:119`). |
| `9553b51` | Trace topology: first local subagent turn now joins the caller's trace; queries that followed `eve.link.type=agent.dispatch` links for local children must switch to `parentSpanId` / `agent.parent_run.id` (`docs/guides/instrumentation/otel.mdx:142-153`). |
| `8aca3d8` | Frontend hooks and `EveAgentStore` share one conversation client; default hooks return `ConversationState` instead of `EveMessageData`; new `followSubagents: true`, `EveAgentStore.compact()/clear()/retire()` (`docs/guides/frontend/overview.mdx` "Returned state"). |
| `ddc8e12` | Slack principal id is now `slack:<installation team>:<user>`; users re-sign-in once to user-scoped connections. |
| `384af57` | Session handoff checkpoint changed shape: an idle session does not move between deployments on either side of this release. |
| `dc50f62` (unreleased) | `gray-matter` replaced by js-yaml 4; frontmatter fences other than `---` / `---yaml` (e.g. `---json`, `---js`) now error. |

### New capabilities (non-breaking)

- `ff12e85`: `session.waiting`, `turn.waiting`, `session.failed`, `session.completed` carry `usage` (running tokens and cost including delegated agents); evals expose `derived.usage`.
- `1094e52`: eval results list `derived.models`.
- `001cc00`: channels can handle `step.started`; readable tool/agent/connection names in activity labels and approval prompts ("Approve Linear: List issues?").
- `ddc8e12`: `connection_search` no longer triggers sign-in; `connection_search({ connection, signIn: true })` signs in to one connection at a time (`docs/concepts/built-in-tools.md:272-273`). One sign-in prompt per shared Vercel Connect connector.
- `8aca3d8`: TUI runs on the shared agent store: prompt stays open while the agent works, slash commands run mid-turn, `Esc`/`Ctrl+C` cancels (no longer steers queued messages).
- `a79fca4`: bounded activity drawer for tasks/subagents in the TUI.
- `3f6d9cf`: `eve/nuxt` shares Next.js dev-server startup; new `devServerTimeoutMs`.
- `4361876`: extensions mounted inside a contributed subagent can read the enclosing extension's config (`docs/extensions.md`).
- `490ac0d`: Slack never silently drops a final reply (snippet fallback, error-id notice, `postCompletedSlackReply`).
- `384af57`: session steps that only publish events no longer store conversation history in step input (smaller stored state).
- `4403122`: remote agents get their own `vercel.session_id` in Agent Runs.
- `ac77188`: build fails when a dynamic remote agent's `auth`/`headers` captures handler-local values.
- `e1130dd`: Web Chat service build fixes; deploy shows Vercel build logs.

### Removed

Nothing removed as a capability. Removed surface: TUI `stderr`/`sandbox` log filters; steering via `Esc` with queued messages in the TUI; `gray-matter` dependency (unreleased).

## 3. Matrix re-verification (all 51 rows of old section 6)

"Changed?" compares against the old audit's eve cell. "No" = same verdict and same substance.

| # | Capability | eve now | Evidence path | Changed vs old audit? |
|---|---|---|---|---|
| 1 | Durability / resume | ✅ [V] | `docs/concepts/execution-model-and-durability.mdx:6-16,94-96` (session = one durable workflow, checkpoint per step); `docs/reference/cli.md:295-311` (`eve dev --resume`) | No |
| 2 | Durable stores | ✅ [V] | `docs/guides/deployment/self-hosting.md:27-47` (local world on disk `.eve/.workflow-data`, custom world package); `docs/agent-config.md:250-285` (`@workflow/world-postgres`, `5.0.0-beta` line) | No. Note: no SQLite/KV store; stores are Workflow SDK worlds |
| 3 | Sandboxing | ✅ [V] | `docs/sandbox/index.mdx:209-217` (Vercel, Docker, microsandbox, just-bash, custom `defineSandboxProvider`) | No |
| 4 | Workspace fs + shell tools | ✅ [V] | `docs/concepts/built-in-tools.md:29-133` (`bash`, `read_file`, `write_file` default; `glob`, `grep` opt-in) | No |
| 5 | Compaction | ✅ [V] | `docs/agent-config.md:147-160`; `docs/concepts/default-harness.md` (auto at 0.9, manual `/compact`, `compaction.requested/completed`) | No |
| 6 | Subagents | ✅ [V] | `docs/subagents/index.mdx:8-18` | No |
| 7 | Background / resumable subagents | ✅ [V] | `docs/tools/tasks.md` (intro, "Ownership and limits"); `docs/subagents/index.mdx:240-248` (`taskId` continuation, `task_cancel`) | No |
| 8 | Remote subagents | ✅ [V] | `docs/guides/remote-agents.md` (`defineRemoteAgent`, callbacks); also `defineWorkspaceAgent` `docs/subagents/index.mdx:83-112` | No |
| 9 | Approvals / HITL | ✅ [V] | `docs/tools/human-in-the-loop.md:35-40` (`never/once/always/auto`), `:67-81` (policy returning approved/denied + reason), `:85-123` (response authorization) | **Behavior changed (0.70.0):** approval holds the turn open (`turn.waiting`, `on: "input"`); a non-matching message from the served person cancels the approval. Verdict unchanged |
| 10 | Agent asks the user a question | ✅ [V] | `docs/concepts/built-in-tools.md:295-309` (`ask_question`, opt-in via `eve add tool/ask_question`); `ctx.ask()` in workflow tools | No (note: opt-in, not default) |
| 11 | Steering | ✅ [V] | `docs/channels/overview.mdx:37-58`; `docs/concepts/execution-model-and-durability.mdx:127-162` (`steer` default, `queue`) | No. TUI no longer steers with `Esc` on queued messages |
| 12 | Cancellation | ✅ [V] | `docs/concepts/sessions-runs-and-streaming.md` "Cancel the in-flight turn" (`POST /eve/v1/session/:id/cancel`); hook `ctx.cancel()` `docs/guides/hooks.md` | No |
| 13 | Memory (cross-session) | ✅ [V] | `docs/memory/overview.mdx:7-24,77-83` (file, Supermemory, Upstash AgentKit, Kybernesis Arcana, custom) | No (old audit listed file/Supermemory/custom; Upstash and Arcana also present) |
| 14 | Sessions (multi-turn) | ✅ [V] | `docs/concepts/sessions-runs-and-streaming.md` (ID-addressed, 30-day default lifetime) | No |
| 15 | Skills (SKILL.md) | ✅ [V] | `docs/skills.mdx:6-12,32-43` | No |
| 16 | AGENTS.md loading | ⚠️ [V] | `docs/instructions.mdx` (instructions.md/.ts/dir only). Grep `AGENTS\.md` in `docs/**`: 0 hits. In `packages/eve/src` only `cli/commands/agent-instructions.ts` and scaffold templates reference it (init writes an `AGENTS.md` for coding agents; the runtime does not load it) | No |
| 17 | Evals | ✅ [V] | `docs/evals/overview.mdx` | No |
| 18 | Eval against deployed URL | ✅ [V] | `docs/evals/targets.mdx`; `docs/reference/cli.md:445-452` (`--url`) | No |
| 19 | Test utils (mock model, record/replay) | ⚠️ [V] | `docs/evals/overview.mdx:104-140` (`mockModel` only). Grep `cassette\|recordReplay\|record-replay` in `docs/**` and `packages/eve/src`: 0 hits | No |
| 20 | Tracing / OTel GenAI | ✅ [V] | `docs/guides/instrumentation/otel.mdx:129-158` (`invoke_agent`, `chat`, `execute_tool`, `gen_ai.conversation.id`) | Verdict no; trace topology changed in 0.70.0 |
| 21 | Metrics / trace viewer | ✅ viewer, ⚠️ metrics [V] | Viewer: `docs/reference/cli.md:379-418` (`eve traces`), `docs/guides/dev-tui.md:32` (`/traces`). Metrics: `otelIntegration({ metricReaders })` exists in `packages/eve/src/tracing/otel-declaration.ts:105-111` but is not in `docs/guides/instrumentation/otel.mdx`; grep `createCounter\|createHistogram\|getMeter(` in `packages/eve/src`: 0 hits, so eve emits no instruments of its own | Refinement: old cell was ✅ on the viewer only; metrics are bring-your-own |
| 22 | Multi-provider | ✅ [V] | `docs/agent-config.md:29-46` (Gateway ids, `eve/models/openai`, `eve/models/anthropic`, any AI SDK `LanguageModel`, `chatgpt()` subscription) | No |
| 23 | Fallbacks / retry policy | ⚠️ [V] | Retry: `packages/eve/src/harness/tool-loop.ts:300` `MODEL_CALL_MAX_ATTEMPTS = 3` for transient model-call failures; documented for subagents at `docs/subagents/index.mdx:238`. Fallback: only `auto({ fallback })` for evaluator failure, `docs/guides/evaluate.md:44-67`. No user-configurable fallback chain or retry policy found; tools are never auto-retried (`docs/tools/overview.mdx:236-240`) | Evidence differs: old cell cited "AI Gateway routing", which I could not find in docs. Verdict unchanged |
| 24 | Structured output | ✅ [V] | `docs/guides/client/output-schema.mdx` (per-turn `outputSchema`, `result.completed`); subagent `ctx.agent().send(..., { outputSchema })` `docs/subagents/index.mdx:211` | No |
| 25 | Multimodal input | ✅ [V] | `docs/guides/client/messages.mdx:64-107` (AI SDK `UserContent`, file parts); tool image output `docs/tools/overview.mdx:285-312` | No |
| 26 | Reasoning control / events | ✅ [V] | `docs/agent-config.md:123-145` (7 levels); `reasoning.appended` / `reasoning.completed` in `docs/concepts/sessions-runs-and-streaming.md` | No |
| 27 | MCP client | ✅ [V] | `docs/connections/mcp.mdx` (`defineMcpClientConnection({ url, auth })`, tool allow/block, approval). Grep `stdio\|command:` in that file: 0 hits, so remote HTTP only | No (note: no stdio transport documented) |
| 28 | MCP server | ✅ [V] | `docs/channels/mcp.mdx` (`agent_start/get/update/cancel`, OAuth) | No |
| 29 | Typed event stream | ✅ [V] | `docs/concepts/sessions-runs-and-streaming.md:112,170` (NDJSON, `x-eve-stream-version` v21-v26, `meta.id`) | Verdict no; `turn.waiting.on` and `usage` fields added |
| 30 | UI bindings React/Vue/Svelte | ✅ [V] | `docs/guides/frontend/overview.mdx` "Per-framework integration" | Verdict no; default returned state type changed (`ConversationState`) |
| 31 | AI SDK UI stream | ⚠️ [V] | `docs/guides/frontend/overview.mdx:175` ("follow the AI SDK `UIMessage` rendering convention, but the types are not interchangeable") | No |
| 32 | CLI scaffolding | ✅ [V] | `docs/getting-started.mdx`; `docs/reference/cli.md:35-60` | No |
| 33 | Dev TUI / REPL | ✅ [V] | `docs/guides/dev-tui.md` | Verdict no; TUI rewritten onto the shared agent store in 0.70.0 |
| 34 | Visual studio / debugger | ⚠️ [V] | TUI trace viewer (`/traces`), hosted "Agent Runs" tab on Vercel (`docs/guides/instrumentation/agent-runs.mdx`, Beta), generated Web Chat app (`eve add channel/web`, `docs/guides/frontend/nextjs.mdx:145`). No local visual studio or time-travel debugger | **Differs from old ❌.** Not a change in eve (those docs are unchanged since 682c7a6); the old cell understated it. Still no Forge equivalent |
| 35 | Channels | ✅ [V] | `docs/channels/overview.mdx:93-108` (eve HTTP, MCP, Slack, Linq, Photon, Discord, Teams, Telegram, Twilio, GitHub, Linear, Chat SDK bridge, custom) | No (old list omitted Linq, Photon, Chat SDK bridge) |
| 36 | Schedules | ✅ [V] | `docs/schedules.mdx` | No |
| 37 | Deploy story | ✅ [V] | `docs/guides/deployment/overview.md`; `self-hosting.md`; `vercel.mdx` | No |
| 38 | Edge runtime (Workers) | ❌ [V] | `packages/eve/package.json:636` (`node >=24`); `docs/guides/deployment/overview.md` lists only Vercel and Node self-host. Grep `Cloudflare\|Workers\|Deno\|Bun` in `docs/**`: no runtime target | No |
| 39 | Budgets / limits | ✅ [V] | `docs/agent-config.md:162-248` (input/output tokens, USD cost, session timeout, approve-to-continue, quota split across subagents) | No |
| 40 | Guardrails (input/output) | ⚠️ [V] | `auto()` approval classifier `docs/tools/human-in-the-loop.md:44-63`; hook `ctx.cancel()` on `turn.started` can stop a turn (`docs/guides/hooks.md` "Cancel the running turn from a hook"). Grep `guardrail` in `docs/**`: 1 hit, about `placeholderAuth()` | No |
| 41 | Permissions policy | ✅ [V] | `docs/tools/human-in-the-loop.md`; per-connection approval `docs/connections/overview.mdx` "Per-connection approval"; MCP tool allow/block `docs/connections/mcp.mdx` "Tool filters" | No |
| 42 | Credential brokering | ✅ (Vercel Sandbox backend) [V] | `docs/concepts/security-model.md:52-54`; header-transform policy `docs/sandbox/vercel.mdx` "Network policy" | No |
| 43 | Dynamic config | ✅ [V] | `docs/guides/dynamic-capabilities.md` (model, subagents, connections, tools, skills, instructions) | No (connections and subagents now also dynamic; old cell listed them partly) |
| 44 | Hot reload | ✅ [V] | `docs/reference/cli.md:285-289` (immutable runtime generations) | No |
| 45 | Registry / extensions | ✅ [V] | `docs/extensions.md`; `docs/install-integrations.mdx` (shadcn registry format, `eve add`, `eve registry`) | No |
| 46 | ACP | ✅ [V] | `docs/protocols/acp.md` (ACP v1 over stdio, local or `--url` bridge) | No |
| 47 | Code-first authoring | ⚠️ [V] | `docs/reference/typescript-api.md:8` ("Identity comes from the filesystem"); programs use `eve/client`. `research/programmatic-agent-sources.md` describes "framework-owned programmatic modules", an internal compiler concept, not a public `createAgent()`-style API | No |
| 48 | Directory authoring | ✅ [V] | `docs/reference/agent-files.md` | No |
| 49 | Agent-readable docs | ✅ [V] | `packages/eve/package.json` `files: ["bin","dist","docs",...]`; scaffolded `AGENTS.md` tells coding agents to `ls node_modules/eve/docs` (`packages/eve/src/setup/scaffold/create/project.ts:299-355`) | No |
| 50 | Published on npm | ✅ `eve` **0.70.0** [V] | `npm view eve version` | **Yes: 0.69.0 -> 0.70.0** |
| 51 | Current `ai` major | ✅ v7 [V] | `pnpm-workspace.yaml:50` `ai: "^7.0.105"` | No |

Summary: no verdict flipped because of eve's own changes in the one-day window. Two cells differ from the old audit on re-reading (row 34 ❌ -> ⚠️, row 21 split), one value changed (row 50), and row 9's event contract changed materially.

## 4. Capabilities not in the old matrix

All [V] at the cited path unless marked. Grouped; each is one line.

### Tools and the agent loop

| Capability | What it is | Path |
|---|---|---|
| Tool search / lazy connection tools | `connection_search` + `connection_execute` expose every MCP/OpenAPI tool without adding each to the model's tool list; definitions never change in-session to preserve the cached prompt prefix | `docs/concepts/built-in-tools.md:268-278` |
| OpenAPI connections | Turn an OpenAPI 3.x / Swagger 2.0 document into tools with operation filters and approval gates | `docs/connections/openapi.mdx` |
| Durable workflow tools | `defineWorkflowTool` with `"use workflow"`: waits for people, webhooks, timers without holding compute; `ctx.ask`, `ctx.agent`, `execute` / `task` / `serve` entry points | `docs/tools/workflows.mdx` |
| Tasks model | Tool calls that return a receipt and keep working; `task_wait`, `task_cancel`, resumable tasks by `taskId`, `[Tasks]` note | `docs/tools/tasks.md` |
| Model-written orchestration program (code-mode-like) | Opt-in `workflow` tool: the model supplies a JS async body whose only capability is `ctx.agent(...)`; fan-out/fan-in up to 128 subagents. Uses `@ai-sdk/code-mode` (`pnpm-workspace.yaml:33`, `packages/eve/src/shared/workflow-sandbox.ts`) | `docs/tools/workflows.mdx` "Add a runtime-generated workflow tool" |
| Durable `sleep` tool | Pauses and durably resumes a turn; interrupted by steering | `docs/concepts/built-in-tools.md:379-405` |
| `no_reply` and `endsTurn` | End a turn with no message (scheduled checks, reactions); `endsTurn: true \| (output) => boolean` on any tool | `docs/concepts/built-in-tools.md:363-377`; `docs/tools/overview.mdx:63-107` |
| `web_search` / `web_fetch` built-ins | Provider-managed search (Exa via Gateway by default, `parallel` option); fetch with SSRF checks and 10-redirect cap | `docs/concepts/built-in-tools.md:135-214` |
| Streaming partial tool results | Async-generator `execute` emits `action.partial` snapshots; `label.start/delta/complete` activity labels | `docs/tools/overview.mdx:109-175` |
| `toModelOutput` + image parts | Project tool output for the model separately from channels; return images as content parts | `docs/tools/overview.mdx:271-312` |
| Schema flexibility | Zod, any Standard Schema, or raw JSON Schema for `inputSchema`; `outputSchema`; `serializeModelInputSchema` for tests | `docs/tools/overview.mdx:26-42`; `docs/reference/cli.md:202` |
| Tool visibility controls | `availableInSubagents: false`, `disableTool()`, `defaultTools: false`, subagent `tool: false` | `docs/tools/overview.mdx:44-59`; `docs/concepts/built-in-tools.md:12-27` |
| Session-scoped durable state | `defineState(name, initial)` with `get()/update()`, committed at step boundaries | `docs/concepts/state.md` |
| Hooks | `defineHook` subscribes to stream events after they are durable; `ctx.cancel()`; a throwing hook never vetoes | `docs/guides/hooks.md` |
| Ephemeral per-turn client context | `clientContext` adds user-role context for one turn, never persisted | `docs/guides/client/messages.mdx:45-62` |
| User-role instructions | `defineInstructions({ role: "user" })` seeds durable history; instruction directories | `docs/instructions.mdx:31-59` |

### Models

| Capability | What it is | Path |
|---|---|---|
| Automatic model selection | `auto({ options, fallback })` from `eve/models` routes each turn with an evaluation model (default `typesafe-ai/jev`) | `docs/guides/evaluate.md` |
| `evaluate()` API | Typed choice/score/boolean questions for use in tools; also backs `t.judge` and `auto()` approvals | `docs/guides/evaluate.md:132-178` |
| ChatGPT subscription models | `chatgpt()` bills a local ChatGPT login (via `codex app-server` or OS keychain); blocked from deploy | `docs/reference/typescript-api.md:165-206` |
| Provider safety identifier | Auto-fills OpenAI `safetyIdentifier` / Anthropic `metadata.userId` with a hash of the principal; Gateway `sessionId` per conversation | `docs/agent-config.md:50-68` |
| Prompt-cache-aware design | No cache-control API found; the framework keeps tool definitions fixed and context append-only, and documents "eve does not promise a cache hit" | `docs/instructions.mdx:85-89`; `docs/concepts/built-in-tools.md:276` |
| Vision routing example | `step.started` dynamic model switches to a vision model when history contains an image | `docs/guides/dynamic-capabilities.md` "Route image inputs to a vision model" |

### Auth, tenancy, security

| Capability | What it is | Path |
|---|---|---|
| Route auth walk | Ordered `AuthFn` array; helpers `localDev`, `vercelOidc`, `none`, `httpBasic`, `jwtHmac`, `jwtEcdsa`, `oidc`; fails closed with 401; `placeholderAuth()` scaffold | `docs/guides/auth-and-route-protection.md` "Verifier helpers" |
| Principals in session | `ctx.session.auth.current` / `.initiator` carried into tools, approvals, memory scope, dynamic resolvers | `docs/guides/auth-and-route-protection.md` "What reaches `ctx.session.auth`" |
| IP allow list | `createIpAllowList`, `isIpAllowed` drop requests before auth | same file, "Network policy" |
| Forwarded identity | `trustedForwarders` on `eveChannel` for remote-agent principal forwarding | same file, "Accepting forwarded identity from another deployment" |
| Third-party OAuth for connections and tools | `connect()` (Vercel Connect) or self-hosted `defineInteractiveAuthorization`; app vs user credential owner; turn parks until sign-in completes; `ctx.getToken` / `ctx.requireAuth` in tools | `docs/connections/overview.mdx` "Interactive OAuth via Vercel Connect", "Self-hosted interactive OAuth"; auth guide "Tool and connection auth" |
| Approval response authorization | Policy deciding who may approve or cancel a specific call | `docs/tools/human-in-the-loop.md:85-159` |
| Multi-tenant patterns | Tenant-scoped approvals, outbound auth, memory | `docs/patterns/multi-tenant-approvals.md`, `multi-tenant-auth.md`, `multi-tenant-memory.md` |
| Channel signature verification | Constant-time HMAC verification for platform channels | `docs/concepts/security-model.md:60-74` |
| Trace content policy | `tracePolicy` by audience (`public/private/unknown`), per-destination `exportPolicy` redaction | `docs/guides/instrumentation/otel.mdx:22-39,184-210`; `docs/channels/overview.mdx:24-35` |

### Sessions, client, frontend

| Capability | What it is | Path |
|---|---|---|
| Session controls | `compact`, `clear`, `reset` routes and client methods | `docs/concepts/sessions-runs-and-streaming.md` "Compact, clear, and reset" |
| Durable, rewindable stream | `startIndex` (absolute or tail-relative), renewable leases, `meta.id` dedupe, `snapshot()`, bounded `follow: false` reads | same file "Reconnect and rewind"; `docs/guides/client/streaming.mdx` |
| Follow a subagent stream | `session.agent(agentStartedEvent).stream()`; `followSubagents: true` in hooks | `docs/guides/client/streaming.mdx` "Follow a subagent" |
| In-process session reads | `sessions.attach(id).stream()` from `eve/server` | sessions doc "Read a session in process" |
| Session prewarming | `client.sessions.create()` without a message while the user types | `docs/guides/client/overview.mdx` "Sessions" |
| Deployment handoff | Idle sessions move to the newest deployment, keeping id and stream | `docs/concepts/execution-model-and-durability.mdx:26-30` |
| Run data retention / checkpoint batching | `experimental.workflow.retention`, `modelCallsPerStep` | `docs/agent-config.md:287-355` |
| Agent inspection | `eve info --json`, `GET /eve/v1/info` (agent-info v6) | `docs/reference/cli.md:139-202` |
| Framework plugins | `withEve` (Next.js), `eve/nuxt`, `eveSvelteKit`; generated Web Chat app via `eve add channel/web` | `docs/guides/frontend/nextjs.mdx`, `nuxt.mdx`, `sveltekit.mdx` |
| Attachments pipeline | `UserContent` file parts; channels stage bytes to the sandbox via `fetchFile`; `session.sendFile` in evals | `docs/channels/custom.mdx:472-524`; `docs/guides/client/messages.mdx:64-107` |

### Channels and surfaces

| Capability | What it is | Path |
|---|---|---|
| Teams | Bot Framework activities, Adaptive Card HITL | `docs/channels/teams.mdx` |
| Telegram | Bot webhooks, inline-keyboard HITL, attachments | `docs/channels/telegram.mdx` |
| Twilio | SMS plus speech-transcribed phone calls (`<Gather input="speech">`); no native realtime voice | `docs/channels/twilio.mdx:7,28-29` |
| GitHub | App webhooks, comment invocation, PR diff context, sandbox checkout | `docs/channels/github.mdx` |
| Linear | Agent Sessions with native Agent Activities | `docs/channels/linear.mdx` |
| iMessage / SMS | Linq and Photon channels | `docs/channels/linq.mdx`, `photon.mdx` |
| Chat SDK bridge | Any Vercel Chat SDK adapter (WhatsApp, email via Resend, Google Chat, X, ...) | `docs/channels/chat-sdk.mdx` |
| WebSocket routes | `WS()` in `defineChannel`; Node upgrade escape hatch | `docs/channels/custom.mdx` "WebSocket routes" |
| Cross-channel hand-off | `ctx.to(channel, target).send(...)` starts the conversation elsewhere; proactive sessions | `docs/channels/custom.mdx` "Cross-channel hand-off" |
| Queue turn policy with batching | `turnPolicy: "queue"` folds adjacent same-auth messages into one turn | `docs/channels/overview.mdx:43-56` |
| UCP profile | Serve a Universal Commerce Protocol profile from a channel | `docs/protocols/ucp.mdx` |
| Buzz ACP adapter | `@eve/buzz-acp-adapter` bridges Buzz to `eve acp` (experimental) | `packages/eve-buzz-acp-adapter/README.md` |

### Ecosystem, CLI, deployment

| Capability | What it is | Path |
|---|---|---|
| Integration catalog | 95 catalog entries: 28 channels, 46 connections, 9 extensions, 8 instrumentation, 4 memory; plus skills.sh as `@skills`; self-hosted registries | `packages/eve-catalog/src/index.ts`; `docs/install-integrations.mdx` |
| Extension packages | Bundle tools, channels, connections, skills, schedules, subagents, instructions, hooks; `eve extension init/build`; namespaced mounts and overrides | `docs/extensions.md` |
| Self-modification | Dev-only bundled subagent edits the agent's own files on request | `docs/guides/self-modification.md` |
| Coding extension | `eve/extensions/code`: `apply_patch`, `gh`, `grep`, PR/review skills, read-only worker subagent, credential-brokered GitHub tokens. Source only, not in `docs/**` | `packages/eve-code/README.md` |
| Computer use | `eve/computer-use`: `computer_use` tool driving a Linux desktop in the sandbox. Source only, not in `docs/**` | `packages/eve-computer-use/README.md` |
| Remote CLI | `eve remote connect/invoke/info`; headless `invoke` returns resumable JSON, exit code 3 when paused | `docs/reference/cli.md:313-357` |
| Diagnostic logs | `eve logs` (JSONL, `--events`, `--dump`) | `docs/reference/cli.md:359-377` |
| `eve set model` | Edit model/reasoning in `agent.ts` from the CLI | `docs/reference/cli.md:92-112` |
| Agent workspaces | Several root agents under `agents/<name>/`; workspace peers via `defineWorkspaceAgent` | `docs/concepts/project-structure.mdx`; `docs/subagents/index.mdx:83-112` |
| Hosted run viewer | Vercel "Agent Runs" (Beta) for sessions, turns, subagents, usage | `docs/guides/instrumentation/agent-runs.mdx` |
| Lifecycle instrumentation | `defineInstrumentation({ events })` with idempotency keys; `eve add instrumentation/braintrust` | `docs/guides/instrumentation/instrumentation.mdx` |
| Eval extras | Datasets, multi-turn drive API, HITL in evals, `t.judge`, reporters Braintrust / Datadog / JUnit, run setup/teardown, schedule dispatch, artifacts under `.eve/evals/` | `docs/evals/cases.mdx`, `judge.mdx`, `reporters.mdx`, `running.mdx`, `targets.mdx` |
| Sandbox extras | Custom providers, `prepare` snapshots/images, parent-sandbox sharing, workspace seeding, per-domain network policy | `docs/sandbox/index.mdx`, `vercel.mdx` |
| Dynamic scheduling pattern | App-owned schedule rows behind one per-minute dispatcher; dev dispatch route | `docs/patterns/dynamic-scheduling.md`; `docs/schedules.mdx:108-119` |
| Templates | `eve-chat-template`, `eve-llm-council-template`, `eve-slack-agent-template`, `personal-agent-template` (directories seen, contents not read) | `apps/templates/` |
| CLI telemetry | On by default; `eve telemetry disable` | `docs/reference/telemetry.md` |

### Looked for and not found

| Topic | Result |
|---|---|
| Session forking | Not found. Grep `fork` in `docs/**`: 0 hits; in `packages/eve/src` only process/docker forking |
| Plan mode, todo tools | Not found. Grep `todo\|plan mode\|code mode` in `docs/**`: 0 hits |
| Record/replay fixtures | Not found (row 19) |
| Input/output guardrails | Not found as a feature (row 40) |
| Rate limiting | Not found as a feature. Grep `rate.?limit` in `docs/**`: no feature hit; source hits are provider-error classification only |
| Durable message queue | Explicitly absent: "eve does not maintain a durable FIFO queue of user messages" (`docs/concepts/execution-model-and-durability.mdx:129`); notifications need an app-owned outbox (`docs/patterns/durable-cross-channel-notifications.md`) |
| Realtime voice | Not found. Only Twilio speech-to-text calls |
| Human-agent handoff (escalation to a person) | Not found. "Hand-off" in docs means cross-channel routing |
| Analytics product | Not found. Hooks-to-your-DB pattern and Agent Runs only |
| MCP stdio transport | Not found in `docs/connections/mcp.mdx` |
| Model fallback chain | Not found (row 23) |

## 5. DX facts

All [V] from `docs/getting-started.mdx`, `docs/reference/cli.md:35-60`, and `packages/eve/src/setup/scaffold/create/{project.ts,agent-paths.ts,instructions-template.ts,web-template.ts}`.

**Prerequisites:** Node.js 24 or newer; npm; a model credential (ChatGPT subscription, Vercel account, or an AI Gateway / OpenAI / Anthropic key, entered in the TUI). No Vercel project needed to start chatting.

**Empty directory to first reply (documented):**

```bash
npx eve@latest init my-agent
```

That one command creates the project, installs dependencies, runs `git init`, and opens the TUI. The TUI reuses an available model connection or opens `/login`; then type a message. So: 1 command, then 0-1 login step, then the message. To return later: `cd my-agent` then `npm run dev`. Manual alternative: `npm install eve@latest ai zod`, declare Node 24 in `package.json`, create `agent/instructions.md` (and optionally `agent/agent.ts`).

Options: `--model <provider/model-id>` (default `openai/gpt-6-luna-fast`), `--reasoning <effort>` (default `high` when `--model` is omitted), `--channel-web-nextjs` (adds the Next.js Web Chat app), `-n/--non-interactive`. `eve init .` in an existing package adds `agent/` plus missing `eve`, `ai`, `zod`.

**What `eve init` generates (new project):**

| File | Content |
|---|---|
| `agent/agent.ts` | `defineAgent({ model, reasoning })` (BYOK variant adds `modelOptions.providerOptions.gateway.byok`; ChatGPT variant uses `chatgpt()`) |
| `agent/instructions.md` | Short "general-purpose AI agent powered by eve" identity + customization note |
| `agent/channels/eve.ts` | `eveChannel({ auth: [vercelOidc(), localDev(), placeholderAuth()] })` |
| `package.json` | `type: module`; imports `#*` -> `./agent/*`, `#evals/*` -> `./evals/*`; scripts `build`, `deploy`, `dev`, `eval`, `start`, `typecheck`; deps `@vercel/connect`, `ai`, `eve`, `zod`; devDeps `@types/node`, `typescript`; `engines.node` |
| `tsconfig.json` | includes `agent/**/*.ts`, `evals/**/*.ts` |
| `README.md`, `.gitignore`, `.vercelignore` | Boilerplate |
| `AGENTS.md`, `CLAUDE.md` | Guidance for coding agents; tells them to read `node_modules/eve/docs`; `CLAUDE.md` is `@AGENTS.md` |

No `evals/` directory, tools, or skills are generated (the template map has no such keys). Self-modification is mounted automatically in `eve dev`, so a user can ask the agent to add its own tools.

## 6. Things I could not verify

- **Timing.** Nothing was installed or run; time-to-first-reply is not measured.
- **npm tarball contents.** That 0.70.0 corresponds to commit `6181372` is inferred from timestamps; the tarball was not downloaded.
- **Inbound attachment policy.** `docs/guides/client/messages.mdx:105-107` and `docs/channels/custom.mdx:524` link to `sandbox#inbound-attachments`, but `docs/sandbox/index.mdx` has no such heading at HEAD, so storage, size limits, and provider-input behavior for attachments are undocumented in the clone.
- **AI Gateway fallback routing** cited by the old audit for row 23: no supporting text found in `docs/agent-config.md` at HEAD.
- **Hosted pieces:** Vercel Agent Runs UI, the eve.dev Integrations gallery, Vercel Connect, and the registry's live catalog were not opened; claims rest on the docs and `packages/eve-catalog/src/index.ts`.
- **`apps/templates/*` and `apps/frameworks/*`:** directory names only.
- **Stream version history:** whether v26 is new since 682c7a6 was not established (the doc line stating v21-v26 is not in the diff, so probably unchanged) [I].
- **Docs not read line by line:** `docs/channels/{slack,discord,teams,telegram,github,linear}.mdx`, `docs/tutorial/*`, `docs/memory/{file,custom-provider}.md`, `docs/evals/assertions.mdx`, `docs/guides/frontend/{nextjs,nuxt,sveltekit,use-eve-agent-*}.mdx`, `docs/guides/instrumentation/migration.md`, `docs/tools/tasks-upgrade.md` were covered by heading outline, intro paragraphs, and targeted greps only.
- **`metricReaders`:** present in source types; not exercised and not documented in `docs/guides/instrumentation/otel.mdx`.
