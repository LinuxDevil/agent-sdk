# Competitive audit 2: @lousho/build-ai-agent vs eve vs open-harness, and the wider field

Date 2026-10-02. Refresh of [AUDIT.md](AUDIT.md) (written at `a03b1a3`, before the loop's 113 pull requests). The three research reports this file is built from are in [audit2/](audit2/): `eve-report.md`, `open-harness-and-field-report.md`, `our-report.md`. Each marks every claim as verified (file path, command output or URL) or inferred; this file only summarises them. The round-2 plan is [PLAN-2.md](PLAN-2.md).

## 1. What was audited

| Item | Value |
|---|---|
| Us | `main` at `1574d28` (after the lousho rename, #182, and the on-npm wording, #183); the independent check ran on the renamed tree `4ce8a4d`. Version `1.0.0-alpha.8`. |
| eve | `vercel/eve` at `dd50d12` (2026-10-02), npm `eve` **0.70.0** (was 0.69.0). 23 commits since the old audit. Needs Node 24 and `ai` 7. |
| open-harness | `MaxGfeller/open-harness` at `026e8d9`, `@openharness/core` 0.7.0: **the same commit as the old audit**; nothing has landed in 11 weeks. |
| Field (ideas only) | Claude Agent SDK 0.3.287, `@openai/agents` 0.18.0, `@mastra/core` 1.74.0, `ai` 7.0.127 (`ToolLoopAgent`), `@langchain/langgraph` 1.4.18, `@strands-agents/sdk` 1.19.0. Docs and READMEs read, nothing installed. |
| Not verified | No real model call, no Docker daemon, Agent Forge not built in the audited worktree, `ai` 6 only through a stand-in, competitor quickstarts not run. Details in each report's last section. |

## 2. Our matrix, re-scored by an independent check

The loop's tracker ended at 48 ✅ / 2 ⚠️ / 1 ❌ on the 51 rows of AUDIT.md section 6. An independent agent re-checked every "us" cell with a stricter rule: ✅ only if the feature is reachable from a package entry point, documented, tested, and has no documented limit a user would hit at once. Its score is **40 ✅ / 10 ⚠️ / 1 ❌**. The tracker's two ⚠️ (trace viewer, CLI scaffolding unpublished) and the ❌ (not on npm) stand. The eight rows it downgrades:

| Row | Why it is ⚠️, not ✅ | Ticket |
|---|---|---|
| Durable stores | `KVStore` / `KVCheckpointStore` are in no entry point, yet `docs/deployment.md` tells users to construct one in their Worker. No ready-made file `AgentStore` (three classes plus the donor `StorageService` by hand). | R2 |
| Sandboxing | Docker tests skip without a daemon; egress is tested against a fake and refused on Docker Desktop, rootless and remote daemons. | M6 |
| Credential brokering | Same: enforced only on Linux Docker Engine with the agent on the same host; container path tested against a fake. | M6 |
| Background sub-agents | A background sub-agent that needs approval stops and cannot be resumed; the shell tool asks for approval by default, so a coding sub-agent hits this at once. | M4 |
| Multi-provider | Four named providers only. `AiSdkProvider` is not exported, so Google, Bedrock, Azure or Mistral means hand-writing an `LLMProvider`. `ai` 6 is tested with a stand-in. | M2, M8 |
| Multimodal input | Images work; **files are never sent by any built-in provider on any `ai` major** (`acceptsFileParts` defaults to false and nothing overrides it). A PDF becomes a text note. | M1 |
| Edge runtime | The Worker target takes spec files only, with three providers and exactly two built-in tools. | M3 |
| Registry | The permission manifest is shown, not enforced, and there is no registry to install from. | M7 |

Other findings from the same check:

- **DX claim holds, now measured.** The three reference agents are 17 / 27 / 22 lines with 3 / 4 / 4 imported identifiers (old audit: 17 / 57 / 55 and 3 / 11 / 10). All three type-check against `src/` and `dist/`; the coding and durable-job agents ran end to end on the built package with a scripted model. Files: `audit2/reference-agents/lousho/`.
- **The root surface is very large:** 705 root exports, of which the docs' snippets use 123. About 6,750 lines (15% of `src/`) are donor-era or integration code still exported from the root: flows, Jira and GitHub tools (2,828 lines), `EncryptionUtils`, `StorageService`, repository interfaces, delegation, the deprecated `AgentType`.
- **Docs teach the old API.** `AgentExecutor` is imported in snippets of 14 guides; `durable-execution.md` and `workspace-tools.md` open with it; quick-start section 4 sends newcomers to `AgentBuilder` for options `createAgent()` has, and never shows streaming, sessions or approvals. Stale statements: `docs/providers.md` (reasoning deltas "not reported yet"), the README CLI list (no `chat`, `acp`, `add` in places) and Status section (two links to files that do not ship).
- **Missing guides:** MCP, hooks, triggers, a coding-agent walkthrough, migration from the executor API, adding another provider, Cloudflare Workers limits, troubleshooting.
- **Tests:** 2,959 cases in 213 files; lint and typecheck clean; one explicit `any`. The full run is not reliably green on Windows / Node 26: a native vitest crash leaves a build lock that is only considered stale after 3 minutes, so the next run's deploy tests time out.
- **Tarball:** 3.17 MB packed, 11.7 MB unpacked, 715 files (without Agent Forge, which was not built there): 47% of the unpacked size is source maps, `src/` ships next to `dist/`, and 15 test-only files ship.

## 3. eve (0.70.0)

No matrix verdict flipped in the one-day window. Corrections to the old audit's eve column: "Visual studio / debugger" is ⚠️, not ❌ (TUI `/traces`, the hosted Agent Runs tab, a generated Web Chat app); "Metrics / trace viewer" is ✅ for the viewer and ⚠️ for metrics (bring your own, eve emits no instruments); "Fallbacks" is still ⚠️ (a 3-attempt transient retry, no fallback chain).

0.70.0 changed the approval contract: an approval or sign-in now holds the turn open (`turn.waiting`), and a non-matching message from the person the turn serves cancels the pending approval.

**What eve has that our matrix never tracked** (full table in `audit2/eve-report.md` section 4):

| Area | eve | Us today |
|---|---|---|
| Tool search | `connection_search` / `connection_execute`: every MCP or OpenAPI tool reachable without adding it to the model's tool list | None: every MCP tool is in the tool list |
| OpenAPI connections | An OpenAPI document becomes tools, with filters and approval gates | None |
| Third-party OAuth for tools | Interactive sign-in parks the turn; app or user credentials; `ctx.getToken` | None (static headers and env only) |
| Route auth and principals | Ordered auth functions (`jwtHmac`, `oidc`, `httpBasic`, ...), principals carried into tools, approvals and memory scope; multi-tenant patterns | A bearer token on the session API; no principal model |
| Channels | Slack, Discord, Teams, Telegram, Twilio, GitHub, Linear, iMessage, Chat SDK bridge (WhatsApp, email, ...) | Slack, Discord, webhook, HTTP |
| Web tools | Built-in `web_search` and `web_fetch` | `http` tool only |
| Tool results | Streaming partial results, `toModelOutput`, image parts in tool output | Final result only |
| Session state | `defineState()` committed at step boundaries; `compact` / `clear` / `reset` | Memory slots; compact and clear exist |
| Stream | Rewindable by index, follow a sub-agent's stream | Resume by event id exists; no sub-agent follow |
| Ecosystem | A 95-entry integration catalog, extension packages, templates | `lousho add` with no registry behind it |
| Model selection | `auto()` routes each turn with an evaluator model | None |

**What eve does not have** (grep of docs and source): session forking, plan or todo tools, record/replay, input/output guardrails, a model fallback chain, MCP over stdio, an edge runtime, a code-first `createAgent()`-style API. Those remain ours.

## 4. open-harness (0.7.0, unchanged)

Every cell re-confirmed at the same commit. One correction: "Current `ai` major" is ⚠️ (it depends on `ai` 6; latest is 7). Capabilities not in the old matrix: todo tools with `useTodos` UI hooks, client-side resumable UI streams, runner / middleware composition (`pipe`, `withRetry`, `withCompaction`), a ChatGPT-subscription model provider, a virtual filesystem provider. Its quickstart gives no run command and an unpinned `npm install @ai-sdk/openai` now resolves to a major that does not match its `ai` 6 (inferred from npm metadata, not run).

open-harness is no longer the competitor to chase: on the 51 rows it scores 15 ✅ against our 40. The comparison that matters is eve for features and the wider field for ideas.

## 5. The wider field: ranked ideas

From `audit2/open-harness-and-field-report.md` part B. Ranked by user-visible gap times breadth of adoption.

| # | Idea | Who ships it | Our state |
|---|---|---|---|
| 1 | Multimodal and file input | everyone, including open-harness | images only (row 25) |
| 2 | Local trace viewer (`npx` command, localhost UI over the spans we emit) | AI SDK DevTools, Mastra Studio, eve `traces` | none |
| 3 | Hosted provider tools (web search, code interpreter, file search) | OpenAI Agents, Claude Agent SDK, Strands | none |
| 4 | Tool search / deferred tools | Claude Agent SDK, OpenAI Agents, AI SDK, eve | none |
| 5 | Session fork, resume-at-message, time travel as a first-class API | Claude Agent SDK, LangGraph | `AgentExecutor.fork()` only; not on `agent.session()` |
| 6 | Permission modes (`plan`, `acceptEdits`, `dontAsk`, classifier `auto`) | Claude Agent SDK | policies exist, no named modes, no plan mode |
| 7 | Guardrail starter set with tripwires (prompt injection, PII, moderation, cost) | OpenAI Agents, Mastra | hook points only |
| 8 | Handoffs (transfer the conversation to another agent) | OpenAI Agents, Strands | sub-agents as tools only |
| 9 | File checkpointing and rewind for workspace edits | Claude Agent SDK | none |
| 10 | Semantic recall / observational memory | Mastra | memory slots, newest-first |
| 11 | Code mode (one sandboxed script calls many tools) | Mastra, AI SDK, OpenAI, eve | none |
| 12 | Policy-as-code approvals with shadow mode; signed approvals | AI SDK | none |

Next in line: voice / realtime, live scorers on production traces, hosted sandbox clients (E2B, Modal, Daytona), graph workflows with `interrupt()`, prompt-cache controls, a todo UI hook.

## 6. Feature matrix 2

The 51 old rows keep their order in the scorecard; these 14 rows are added because a competitor or the field ships them. ✅ yes, ⚠️ partial, ❌ no.

| Capability | us | eve | open-harness | Ticket |
|---|---|---|---|---|
| File (PDF, document) input | ⚠️ images only | ✅ | ✅ | M1 |
| Any AI SDK model as provider | ❌ | ✅ | ✅ | M2 |
| Hosted provider tools | ❌ | ✅ web search, fetch | ❌ | N1 |
| Tool search / deferred tools | ❌ | ✅ | ❌ | N2 |
| OpenAPI to tools | ❌ | ✅ | ❌ | N8 |
| OAuth for tools and connections | ❌ | ✅ | ❌ | N9 |
| Route auth and principals | ⚠️ bearer token | ✅ | ❌ | N10 |
| Session fork / time travel API | ⚠️ executor only | ❌ | ⚠️ sub-agent fork | N3 |
| Permission modes / plan mode | ⚠️ policies | ⚠️ `auto()` | ❌ | N4 |
| Guardrail starter set | ❌ | ❌ | ❌ | N5 |
| Handoffs | ❌ | ⚠️ cross-channel | ❌ | N6 |
| Workspace rewind | ❌ | ❌ | ❌ | N7 |
| Channels beyond Slack / Discord | ❌ | ✅ nine more | ❌ | N11 |
| Todo tools with UI hooks | ⚠️ tools, no hook | ❌ | ✅ | N12 |

Totals with the strict rule: old 51 rows 40 / 10 / 1; the 14 new rows 0 / 5 / 9. On all 65 rows we are at **40 ✅ / 15 ⚠️ / 10 ❌**; eve is at 53 / 6 / 6 by the same reading.

## 7. Where we still win

Unchanged from AUDIT.md section 7, and re-confirmed against eve 0.70.0:

1. **Runs anywhere as a library.** eve needs Node 24, a Nitro server and Workflow worlds; we are an import, on Node 22 and (for spec files) Cloudflare Workers.
2. **Record/replay and trajectory evals** with cassettes and drift reports. eve has `mockModel` only; open-harness has nothing.
3. **Input/output guardrails, fallback chains, MCP over stdio, session forking**: all absent in eve.
4. **Agent Forge.** Neither competitor ships a local visual studio.
5. **`ai` 4, 6 and 7 and zod 3 and 4** behind one API.

The gap is no longer core runtime features. It is (a) things that are claimed but only half true (section 2), (b) the first hour: docs that teach the old API and a surface of 705 exports, and (c) the integration layer eve has built: tool search, OAuth, auth, channels, a catalog.
