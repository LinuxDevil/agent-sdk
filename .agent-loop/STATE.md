# Agent-loop state

Mission: make `@loushy/build-ai-agent` the best TypeScript AI agent SDK (capabilities and DX) against
Vercel eve and MaxGfeller/open-harness. This file is the loop's memory: read it first, update it last.

- Loop started: 2026-10-01. Iterations completed: 5.
- Audit: `.agent-loop/AUDIT.md`, refreshed 2026-10-01 at main `a03b1a3` (eve 0.69.0 @682c7a6, open-harness 0.7.0 @026e8d9).
  Reference agents (3 agents x 3 SDKs, measured): `.agent-loop/reference-agents/`. Older material: `docs/research/*.md`, `docs/plan/tickets.md`.
  Audit is stale when: a competitor ships a new major, or more than ~25 PRs land after `a03b1a3` (re-run the DX measurement then).

## Decisions

| # | Decision |
|---|---|
| 1 | Ticket keys keep the repo's `LOU-<epic><n>` scheme. PR titles: `[EPIC-<letter>][LOU-<id>] <summary>`. |
| 2 | Jira: the connected Atlassian site (`data4altayyargroup.atlassian.net`) has no `LOU` project. Tracking lives here until the owner names a project key. Not blocking. |
| 3 | Merge policy: squash-merge once the subagent's local typecheck + lint + full vitest + build + fallow pass; CI is not awaited. **Owner instruction (2026-10-01): do not delete branches**, ever (merged or not). Remaining open PRs get `origin/main` merged in (never rebased) and generated `llms*.txt` regenerated with `npm run docs:llms`. |
| 4 | Subagents work in git worktrees, run `npm ci` there (666 MB each, disk is fine), and follow `/tmp/.../scratchpad/BRIEF.md` (shared brief; recreate from this file's "Subagent brief" section if the scratchpad is gone). |
| 5 | Max one ticket per batch may touch `src/execution/AgentExecutor.ts`, `resume.ts` or `toolCallExecution.ts`; those files are the conflict hub. |
| 6 | New epics from the audit: Epic P (UI bindings, channels, schedules). Letters E and F are reserved (historic tickets cited in code comments). The `ai` v4 -> v7 upgrade is D22-D29 (supersedes the D11 umbrella). |
| 7 | Audit ticket X10 (in-memory approval store) is covered by D21's `InMemoryApprovalStore`; closed as duplicate. |
| 9 | Owner instruction (2026-10-01): do not wait for CI; iterate continuously. CI results are read only when a failure is reported. |
| 8 | A second Claude session (`session_01F3s6hrJ2zhYHbSjvVCSEjZ`, now idle) merged PR #68 during iteration 1. If another session is active on this repo again, check `list_sessions` before merging. |

## Competitor matrix (summary)

Full matrix with evidence links: `.agent-loop/AUDIT.md` section 6 (51 rows). Our cell per row and the ticket that flips it.
Legend: ✅ parity or better, ⚠️ partial, ❌ missing. "flipped" = changed by this loop.

| Row | us | eve | OH | flips with |
|---|---|---|---|---|
| Durability / resume | ✅ flipped (W9: sessions checkpoint per step, `session.resume()` #89) | ✅ | ⚠️ | D30 (one `store` option), W9.2 (fingerprint) |
| Durable stores (SQLite/file/KV) | ✅ | ✅ | ❌ | - |
| Sandboxing | ⚠️ | ✅ | ⚠️ | X11 |
| Workspace fs + shell tools | ✅ | ✅ | ✅ | - |
| Compaction | ✅ flipped (W2 prune #80, W3 summarize/two-phase/pinned #84) | ✅ | ✅ | W3.2 (`compaction.*` events, `createAgent({ compaction })`) |
| Subagents | ✅ | ✅ | ✅ | - |
| Background / resumable subagents | ✅ flipped (Y4 #91 + Y4.2 #92: run-end cancel/await, `result.backgroundTasks`, `subagentOptions`) | ✅ | ✅ | Y6 (resumable children) |
| Remote subagents | ❌ | ✅ | ❌ | Y7 |
| Approvals / HITL | ✅ flipped (D21, #75) | ✅ | ⚠️ | X8 (policies) |
| Agent asks the user a question | ❌ | ✅ | ❌ | X9 |
| Steering (mid-run input) | ❌ | ✅ | ❌ | V9, V10 |
| Cancellation | ✅ | ✅ | ✅ | - |
| Memory (cross-session) | ❌ | ✅ | ❌ | W6 |
| Sessions (multi-turn) | ✅ flipped (V8 session.stream, #78) | ✅ | ✅ | W9 (checkpointing sessions, durability row) |
| Skills (SKILL.md) | ✅ | ✅ | ✅ | - |
| AGENTS.md loading | ✅ | ⚠️ | ✅ | - |
| Evals | ✅ | ✅ | ❌ | - |
| Eval against deployed URL | ❌ | ✅ | ❌ | D47 |
| Test utils (mock model, record/replay) | ✅ | ⚠️ | ❌ | - |
| Tracing / OTel GenAI | ✅ | ✅ | ❌ | - |
| Metrics / trace viewer | ❌ | ✅ | ❌ | D48 |
| Multi-provider | ⚠️ (`ai` v4) | ✅ | ✅ | D22-D29 |
| Fallbacks / retry policy | ✅ (V7.1 #74, V7.2 agent-level + events #86) | ⚠️ | ⚠️ | - |
| Structured output | ✅ flipped (V4 #90: `output` schema, repair step, `output-invalid`) | ✅ | ❌ | - |
| Multimodal input | ❌ | ✅ | ✅ | V11, V12 |
| Reasoning control / events | ❌ | ✅ | ⚠️ | V13 |
| MCP client | ⚠️ (spec field D20 #73; no connect helper) | ✅ | ✅ | Z4 |
| MCP server | ✅ | ✅ | ❌ | - |
| Typed event stream | ✅ | ✅ | ✅ | - |
| UI bindings React/Vue/Svelte | ⚠️ flipped (React `useLoushyAgent` #85) | ✅ | ⚠️ | P2, P3 |
| AI SDK UI stream | ❌ | ⚠️ | ✅ | P1 |
| CLI scaffolding | ⚠️ (unpublished) | ✅ | ❌ | D49, U20 |
| Dev TUI / REPL | ⚠️ | ✅ | ⚠️ | D32, D33 |
| Visual studio / debugger | ✅ | ❌ | ❌ | - |
| Channels | ⚠️ | ✅ | ❌ | P5-P7 |
| Schedules | ⚠️ | ✅ | ❌ | P8, P9 |
| Deploy story | ⚠️ | ✅ | ❌ | D14 |
| Edge runtime (Workers) | ✅ | ❌ | ❌ | - |
| Budgets / limits | ⚠️ (`max-steps` finish reason #83) | ✅ | ⚠️ | V6 |
| Guardrails (input/output) | ⚠️ | ⚠️ | ❌ | X4, X5 |
| Permissions policy | ⚠️ | ✅ | ⚠️ | X2, X8 |
| Credential brokering | ❌ | ✅ | ❌ | X11, X12 |
| Dynamic config | ❌ | ✅ | ⚠️ | V15 |
| Hot reload | ⚠️ | ✅ | ❌ | D31 |
| Registry / extensions | ❌ | ✅ | ❌ | D50 |
| ACP | ❌ | ✅ | ❌ | Z6 |
| Code-first authoring | ✅ | ⚠️ | ✅ | - |
| Directory authoring | ✅ | ✅ | ❌ | - |
| Agent-readable docs | ✅ | ✅ | ✅ | - |
| Published on npm | ❌ (owner action) | ✅ | ✅ | D49 |
| Current `ai` major | ❌ | ✅ | ✅ | D22-D29 |

Score (us): 23 ✅ / 14 ⚠️ / 14 ❌ of 51 after iteration 5 (iteration 4: 22/15/14; iteration 3: 20/15/16 (iteration 2: 19/15/17; iteration 1: 18/15/18; at `a03b1a3`: 16/15/20).

Differentiators shipped (target: 3): 3 of 8 (#1 host-agnostic durable sessions: W9 #89 + D30 #94; #2 record/replay evals: D46 #96; #6 OTel GenAI metrics + cost: D48 #95). Remaining (candidates in AUDIT section 7: host-agnostic durable sessions D30; record/replay evals D46; Forge time-travel D43-D45; MCP+ACP+HTTP reach Z6/D14; both authoring modes with hot reload D31-D33; OTel metrics D48; trajectory evals remote D47; edge-native agents D51/P9).

## Ticket tree

Status: ✅ merged (PR) · 🔄 open PR · ⬜ todo · ⛔ blocked on deps. One point each. Acceptance criteria: `docs/plan/tickets.md` (original) and `.agent-loop/AUDIT.md` section 8 (new).

### Epic U — Correctness
| ID | Title | Status | Deps |
|---|---|---|---|
| U1-U6, U10-U13, U16, U18 | (see docs/plan/tickets.md) | ✅ | |
| U7, U8, U9 | Durable execution gaps | ✅ #68 | |
| U12 | Thrown tool error reaches the model structured | ✅ #37 | |
| U14 | One tool-error shape everywhere (`toolErrorResult`, `kind`) | ✅ #93 | |
| U14.2 | `agentRunState.pushCancelledToolResult` and `subagentRuntime.settleSuspensions` use the shared shape | ⬜ | U14 |
| U15 | Tool execute context real at runtime (sandbox path, `messages`) | ⬜ | |
| U17 | Sandboxed HTTP honors cancellation | ✅ #72 | |
| U19 | Explicit `maxSteps` exhaustion (`finishReason: 'max-steps'`) | ✅ #83 | |
| U20 | Install and roadmap truth (no `npx loushy` of an unpublished package) | ⬜ | |
| U21 | Robust CLI flag parsing (`parseArgs`) | ⬜ | |
| U22 | Resumed sub-agent that pauses again keeps the session awaiting approval | ✅ #77 | |
| U23 | `SubprocessSandbox` (Docker) honors `signal` (follow-up of U17) | ⬜ | |

### Epic V — Run loop
| ID | Title | Status | Deps |
|---|---|---|---|
| V1 cancellation, V2 typed stream, V3 parallel tools, V5 usage/cost | | ✅ | |
| V4 | Structured output (`output: zodSchema`, `result.object`, one repair step, `'output-invalid'`) | ✅ #90 | |
| V4.2 | Sub-agents inherit `output`; typed `session.send()` object | ⬜ | V4 |
| V6 | Budgets (`limits`) | ⬜ | |
| V7.1 | Provider retry + fallback wrappers | ✅ #74 | |
| V7.2 | `createAgent({ retry, fallbackModels })` + `provider.retry`/`provider.fallback` events; retries no longer stack | ✅ #86 | |
| V8 | `session.stream()` | ✅ #78 | |
| V9 | Queued follow-up input | ⬜ | V8 |
| V10 | Steering | ⬜ | V9 |
| V11 | Multimodal message parts | ⬜ | |
| V12 | Multimodal through the public API | ⬜ | V11 |
| V13 | Reasoning effort + events | ⬜ | D26 |
| V14 | Streaming resume after approval (`approve` callback on `stream()` too) | ⬜ | D21 |
| V15 | Per-run dynamic config | ⬜ | |

### Epic W — Context and memory
| ID | Title | Status | Deps |
|---|---|---|---|
| W1 tokens, W4 sessions, W5 SQLite, W7 AGENTS.md | | ✅ | |
| W2 | Compaction: prune old tool results (`createCompactionHook`, prunes the transcript in place) | ✅ #80 | |
| W3 | Compaction: summarize + two-phase strategies, pinned messages, async `compact` | ✅ #84 | |
| W3.2 | Typed `compaction.*` stream events + `createAgent({ compaction })` option | ⬜ | W3 |
| W6 | Scoped memory slots | ⬜ | |
| W8 | Manual compact and clear | ⬜ | W2, W3 |
| W9 | Sessions that checkpoint (`checkpointStore`, `session.resume()/pending()/discardPending()`) | ✅ #89 | |
| W9.2 | Agent fingerprint on resume (warn/refuse on drift) | ⬜ | W9 |

### Epic X — Tools, permissions, hooks
| ID | Title | Status | Deps |
|---|---|---|---|
| X1 defineTool, X6 workspace tools, X7 todo tools | | ✅ | |
| X2 | Permission policies | ⬜ | |
| X3 | Hook outcomes (deny/replace/modify) | ⬜ | |
| X4 | Input/output guardrails | ⬜ | |
| X5 | Enforce `spec.policy` | ⬜ | X2, X4 |
| X8 | Approval policies (`'approve'|'deny'|'ask'`, `once()`) | ⬜ | |
| X9 | `ask_question` tool | ⬜ | X8 |
| X10 | In-memory approval store | ✅ (D21, #75) | |
| X11 | Secret-free sandbox exec + egress allowlist | ⬜ | |
| X12 | Credential brokering proxy | ⬜ | X11 |

### Epic Y — Sub-agents and skills
| ID | Title | Status | Deps |
|---|---|---|---|
| Y1, Y2, Y3, Y5 | | ✅ | |
| Y4 | Background sub-agents (`background: true`, `agent_status/await/cancel`, `withSubagentOptions({ maxConcurrent })`) | ✅ #91 | |
| Y4.2 | Executor `onRunEnd` hook; background children cancelled/awaited at run end; `createAgent({ subagentOptions })` | ✅ #92 | |
| Y6 | Resumable sub-agent sessions | ⬜ | Y4 |
| Y7 | Remote sub-agent | ⬜ | D14 |

### Epic Z — MCP
| ID | Title | Status | Deps |
|---|---|---|---|
| Z1, Z2, Z3 | | ✅ | |
| Z4 | `connectMcp()` + `createAgent({ mcpServers })` (also closes D20.2: specToAgent connects servers) | ⬜ | D20 |
| Z5 | MCP annotations drive approval | ⬜ | Z4 |
| Z6 | `loushy acp` | ⬜ | V14 |

### Epic D — DX, CLI, packaging, testing
| ID | Title | Status | Deps |
|---|---|---|---|
| D1, D3-D10, D12, D13, D17, D19 | | ✅ | |
| D2 | Error codes with fixes | ⬜ | |
| D11 | Upgrade `ai` peer range | superseded by D22-D29 | |
| D14 | Deployed `/chat` upgrade (sessions, SSE, auth) | ⬜ | |
| D15 | React hook `useLoushyAgent` (`./react` subpath, reducer + SSE/NDJSON parser) | ✅ #85 | |
| D16 | ESLint ratchet (433 warnings -> 0, `error` severity) | ⬜ | run in a quiet batch |
| D20 | `mcpServers` in `AgentSpec` | ✅ #73 | |
| D21 | Approvals for `createAgent()` | ✅ #75 | |
| D22 | Own the tool contract (`inputSchema` + `execute`, no `ai.tool()`) | ✅ #79 | |
| D23 | Own the execute-context type | ⬜ | D22 |
| D24 | Small built-ins to `defineTool` | ⬜ | D22 |
| D25 | github and jira to `defineTool` | ⬜ | D22 |
| D26 | `ai` v6/v7 adapter: generate | ⬜ | D23-D25 |
| D27 | `ai` v6/v7 adapter: stream | ⬜ | D26 |
| D28 | Provider peers and ranges | ⬜ | D27 |
| D29 | zod 4 / Standard Schema | ⬜ | D22 |
| D30 | One `store` option (`AgentStore`, `memoryStore()`, `send({ sessionId })`, `agent.resume(id)`) | ✅ #94 | |
| D31 | `loushy dev` for dirs and TS, hot reload | ⬜ | |
| D32 | Stateful streaming dev chat | ⬜ | D31 |
| D33 | `loushy chat` REPL | ⬜ | V14 |
| D34 | `AgentType` off the user path (deprecated; apps/examples still call `setType`, follow-up D34.2) | ✅ #76 | |
| D35 | Delete flow converters, drop `nanoid` (`newId()` on `crypto.randomUUID`) | ✅ #82 | |
| D36 | Delete SaaS/donor utilities (quotas, ConfigManager, formatters, json-path, file-extractor) | ✅ #87 | |
| D37 | Templates out of the root entry | ⬜ | |
| D38 | Remove unwired memory/context/retry modules | ⬜ | V7.1, W6 |
| D39 | Clean `/testing`; deprecate `data/` | ⬜ | |
| D40 | Heavy deps to optional peers (dockerode, MCP SDK, prompts; undici/yaml stay) | ✅ #88 | |
| D41 | One event system | ⬜ | |
| D42 | Shared chunks across entries | ⬜ | |
| D43 | Checkpoint history | ⬜ | |
| D44 | Fork and replay from step N | ⬜ | D43 |
| D45 | Forge time-travel panel | ⬜ | D44 |
| D46 | `loushy eval --record/--replay/--drift` (cassettes per case, drift table + JUnit, `--strict`) | ✅ #96 | |
| D46.2 | Proper provider-middleware hook for eval cassettes (replaces runtime reassignment of `AgentExecutor.execute`) | ⬜ | D46 |
| D47 | Remote eval target | ⬜ | D14 |
| D48 | OTel GenAI metrics (`gen_ai.client.token.usage`, `operation.duration`) + `loushy.cost_usd` | ✅ #95 | |
| D49 | Publish readiness | ⬜ | U20 |
| D50 | `loushy add` | ⬜ | |
| D51 | Deployed API auth + Worker parity | ⬜ | D14 |
| D52 | README revamp (owner request): 805 -> 257 lines, 7 new docs pages | ✅ #81 | |
| D34.2 | Drop `setType` from apps/agent-forge, examples; `ContextBuilder` agentType cast | ⬜ | D34 |
| D25 hazard | github.ts disables tools by replacing `.tool.execute`; sandboxFetch reads `.tool.execute`: must move to canonical `execute` when converted | note | D22 |

### Epic P — UI bindings, channels, schedules
| ID | Title | Status | Deps |
|---|---|---|---|
| P1 | AI SDK UI stream adapter | ⬜ | D27 |
| P2 | Vue composable | ⬜ | D15 |
| P3 | Svelte store | ⬜ | D15 |
| P4 | Next.js route helper | ⬜ | D14, P1 |
| P5 | Slack channel with threads | ⬜ | P7, D21 |
| P6 | Discord channel | ⬜ | P7 |
| P7 | `defineChannel` contract | ⬜ | |
| P8 | Schedules in agent dirs | ⬜ | |
| P9 | Schedules on deploy targets | ⬜ | P8 |

## PR log

| PR | Ticket | State | Notes |
|---|---|---|---|
| #68 | U7, U8, U9 | merged (by session_01F3s6…) | durable execution |
| #72 | U17 | merged (squash) | sandbox fetch abort |
| #75 | D21 | merged (squash) | approvals for createAgent, `InMemoryApprovalStore` |
| #74 | V7.1 | merged (squash, after merging main) | withRetry / withFallback / resilientProvider |
| #73 | D20 | merged (squash, after merging main; CHANGELOG conflict kept both entries) | mcpServers spec field |
| #77 | U22 | merged (squash) | sub-agent re-pause checkpoint |
| #78 | V8 | merged (squash) | session.stream() |
| #76 | D34 | merged (squash) | AgentType optional/deprecated |
| #79 | D22 | merged (squash) | canonical inputSchema/execute on ToolDescriptor |
| #80 | W2 | merged (squash) | compaction prune hook |
| #81 | D52 | merged (squash) | README revamp |
| #83 | U19 | merged (squash) | max-steps finish reason |
| #86 | V7.2 | merged (squash) | agent-level retry/fallback + events |
| #84 | W3 | merged (squash) | summarize compaction |
| #85 | D15 | merged (squash) | React hook |
| #82 | D35 | merged (squash) | converters + nanoid removed |
| #87 | D36 | merged (squash) | donor utilities removed |
| #88 | D40 | merged (squash) | optional heavy peers |
| #91 | Y4 | merged (squash) | background sub-agents |
| #90 | V4 | merged (squash) | structured output |
| #89 | W9 | merged (squash; createAgent.ts conflict with V4 combined by hand) | durable sessions |
| #92 | Y4.2 | merged (squash) | background run-end handling |
| #93 | U14 | merged (squash) | one tool-error shape |
| #94 | D30 | merged (squash) | one `store` option |
| #95 | D48 | merged (squash) | OTel metrics + cost |
| #96 | D46 | merged (squash) | eval record/replay/drift |

## Main health

CI runs only on `pull_request`, so "main is green" means the last PR's CI run passed on its head and local checks passed on the merge. Iteration 2 start: CI runs 117 and 118 green, main green. Iteration 2 merges: every PR verified locally; CI on the final heads of #78/#76/#79/#80/#81 to be checked at iteration 3 start. Local: all four iteration-1 PRs reported green suites (tsc, lint 0 errors / 433 warnings, 1960-1986 vitest tests, build, fallow). Known flaky under load: `guardrails.test.ts` "kills the underlying child process on timeout" (passes in isolation).

## Iteration log

### Iteration 1 (2026-10-01)
- Audit refreshed (`.agent-loop/AUDIT.md`), 64 new tickets planned.
- Merged: #72 (U17), #75 (D21), #74 (V7.1), #73 (D20); #68 (U7-U9) merged by a parallel session. Remote branch deletion is blocked for this session (git push of a delete ref gets HTTP 403 from the proxy, and the GitHub MCP has no delete-branch tool); ~45 merged `lou-*` branches remain on origin. Owner then said: do not delete branches. Branches stay.
- Main at end of iteration: `a37cc61`.
- Matrix flips: Approvals/HITL ⚠️->✅, Fallbacks/retry ❌->✅.

### Iteration 2 (2026-10-01)
- Merged: #77 (U22), #78 (V8), #76 (D34), #79 (D22), #80 (W2), #81 (D52 README revamp, owner request). All synced with main before merge, no conflicts.
- Matrix flips: Sessions ⚠️->✅, Compaction ❌->⚠️.
- Owner instructions received: never delete branches; revamp the README (done).
- Stray file `/resume.fixed.ts` (23 KB) left at the filesystem root by a subagent; removal blocked by the safety check, owner to delete.

### Iteration 3 (2026-10-01)
- Merged: #83 (U19), #86 (V7.2), #84 (W3), #85 (D15), #82 (D35). CHANGELOG/streaming-docs conflicts resolved by keeping both sides; llms regenerated.
- Matrix flips: Compaction ⚠️->✅, UI bindings ❌->⚠️.
- Lint warnings: 433 -> 420 (D35).

### Iteration 4 (2026-10-01)
- Merged: #87 (D36), #88 (D40), #91 (Y4), #90 (V4), #89 (W9). Lint warnings 420 -> 405 (D36).
- Matrix flips: Durability/resume ⚠️->✅, Structured output ❌->✅, Background sub-agents ❌->⚠️.
- Differentiator 1 (host-agnostic durable sessions) is one ticket (D30) from shipped.

### Iteration 5 (2026-10-01)
- Merged: #92 (Y4.2), #93 (U14), #94 (D30), #95 (D48), #96 (D46).
- Matrix flips: Background sub-agents ⚠️->✅. Three differentiators shipped (durable sessions in one option, record/replay evals with drift, OTel metrics + cost).
- Reference agent durable-job.ts now 25 lines (was ~60). Health: D46's author saw fallow list the pre-existing Anthropic/OpenAI duplicate; others report exit 0. A main-health check (full coverage + fallow on main) runs in iteration 6.

## Next batch (iteration 6)

0. Main health (sonnet): full `test:coverage` + `fallow` on main; fix if small (e.g. the provider duplicate block).
1. U15 (sonnet): tool execute context real on the sandbox path (`toolCallId`, `messages`, `abortSignal`); sandboxGuard.ts, toolCallExecution.ts.
2. Z4 (opus): `connectMcp()` + `createAgent({ mcpServers })` + `specToAgent` connects (closes D20.2); src/tools/mcp, createAgent.ts (tools region), spec.
3. D43 (sonnet): checkpoint history per session in SQLite/memory/file stores (`history(sessionId)`); src/storage, checkpoint.ts.
4. D2 (opus): error codes with fixes (`code`, hint, docs link; "did you mean" on spec/config); src/utils/errors.ts, execution/errors.ts, loadSpec, resolveProvider, createAgent validation.
5. D34.2 (sonnet): drop `setType` from apps/agent-forge and examples; ContextBuilder cast.
Then: X8, X2, W3.2, D44, D45, V11, D22-D29 chain (D23 next), Z5, D31.

## Subagent brief (canonical copy)

See `/tmp/claude-0/-home-user-agent-sdk/15860ad4-fff3-53a9-a88b-1d410d4e9ab7/scratchpad/BRIEF.md`; if missing, recreate it with: worktree setup (`git checkout -b <branch> origin/main`, `npm ci`), conventions (tests beside source, `mockModel`, no `any`, regenerate `llms*.txt` via `npm run docs:llms`), the verification list (tsc, lint, test:types, vitest, build both packages, docs:verify-snippets --skip-build, docs:llms:check, test:coverage, fallow), commit trailers (`Co-Authored-By` + `Claude-Session`), PR title/body format with the Claude Code footer, "do not merge", and "never delete branches".
