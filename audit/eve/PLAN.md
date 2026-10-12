# Eve audit — fix plan (2026-10-09)

Inputs:
- `FINDINGS-core.md`, `-tools.md`, `-durability.md`, `-providers.md`, `-multiagent.md`, `-docs-ui.md`
- From the earlier session: `-channels-server.md`, `-cli-onboarding.md`, `-memory-context.md`, `00-live-confirmed-resume.md` (EVE-0)

Re-verification on main `85596018` (fresh alpha.19 tarball, OpenRouter gpt-4o-mini) passed **86/87** harness checks. The one failure is EVE-0, which is still open.

## Corrections to `audit/REPORT.md`

Three fixes that REPORT.md marks as done do not hold on main:

- **B16 (shell allow-list):** still escapable through quotes, `$HOME`, `${IFS}` and braces. See TOOLS-F1.
- **B17 (content on disk):** `redactContent` still defaults to false. See MA-F4.
- **B14 (schedule sessions):** `startSchedules` still passes no `sessionId`. See DUR-F10.

## Rules

- Each PR is about one ticket of roughly one story point.
- Every PR must include a regression test and pass `tsc`, `lint` and the touched vitest suites.
- Update `CHANGELOG.md`, and `api:update` when the public API changes.
- Squash-merge.
- Group work by file area so parallel PRs don't conflict.

## Wave 1 — security, data loss and wrong money (high)

| Ticket | Findings | Files | Status |
|---|---|---|---|
| E1 | TOOLS-F1: shell allow-list quote/`$`/brace bypass | `src/tools/workspace/shellTool.ts` | merged #452 |
| E2 | TOOLS-F2 token redaction (errors/keys/instances/base64); TOOLS-F16 refresh single-flight | `src/execution/sandboxGuard.ts`, `src/oauth/signIn.ts` | merged #455 |
| E3 | TOOLS-F4 MCP `oneOf` collapse; TOOLS-F5 `serveMcp` Host/Origin check | `src/tools/mcp/schema.ts`, `src/tools/mcp/server/httpTransport.ts` | merged #447 #460 |
| E4 | DUR-F5 bytes in SQLite/KV stores; DUR-F6 prune keeps paused turns | `src/storage/sqlite/*`, `src/deploy/kv*` | merged #454 #470 |
| E5 | DUR-F7 + MEM-F3: case-safe file names in file stores | `src/session/sessionStore.ts`, `src/storage/fileStore.ts`, file memory | merged #474 |
| E6 | CORE-F2 listener isolation; CORE-F1 UI remote `sessionId` | `src/execution/agentRun.ts`, `src/ui/agentRunner.ts` | merged #449 #464 |
| E7 | MA-F4 `redactContent` default on; MA-F2 background cost roll-up; MA-F1 failed sub-agent usage | `src/execution/genAiSpans.ts`, `tracing.ts`, `delegation.ts` | merged #457 #466 #477 |
| E8 | DUR-F1 flow variable scoping; DUR-F12/MA-F11 sibling abort | `src/flows/FlowExecutor.ts` | merged #448 #461 |
| E9 | PROV-F1/F2 strict-schema rewrite (oneOf→anyOf, root union wrap, record/tuple) | `src/execution/structuredOutput.ts` | merged #467 (also resolves DUI-F13) |
| E10 | PROV-F3 OpenRouter `usage.cost`, unknown-cost budget warning, id normalisation | `src/providers/OpenRouterProvider.ts`, `src/models/*`, `budget.ts` | merged #450 #459 |

## Wave 2 — sessions and durability (high, touching shared core)

| Ticket | Findings | Files | Status |
|---|---|---|---|
| E11 | DUR-F2 `send({sessionId})` lock; DUR-F3 stale session refresh before run | `src/session/AgentSession.ts`, `src/createAgent.ts` | merged #463 #476 |
| E12 | DUR-F8 `clear()` deletes all turn checkpoints + history | `src/session/AgentSession.ts` | merged #487 |
| E13 | EVE-0 channel sessions use the agent's durable store; resume finds the paused turn | `src/channels/channelCore.ts` | merged #472 (also CF-F1); follow-ups: paused-session lock, pendingCheckpoint scan |
| E14 | DUR-F9 KV approval claim (document + idempotency key) | `src/deploy/kvStore.ts`, docs | merged #542 (+#562 worker build, #569 worker subagents, #573 bytes, #574 sqlite async, #577 SIGTERM drain, #580 CF build errors) |
| E15 | TOOLS-F3 no sign-in links in group chats; TOOLS-F15 issuer namespacing | channels, `src/oauth` | F3 merged #458; F15 merged #465 |
| E16 | MA-F5 agent-dir sub-agents through the native `task` runtime | `src/agentDir/subagents.ts` | merged #478; follow-up: worker runtime delegate_to bypass |
| E18 | DUI-F1 studio auth/CORS; DUI-F3 bad-name crash + error boundary; DUI-F4 mock fallback banner/error | `apps/agent-forge` | merged #475 #499 #512 #527 |
| E19 | DUI-F2 + F7 studio agents via server store (HttpAgentStore) | `apps/agent-forge/src` | merged #521 |
| E20 | DUI-F6 ops-pipeline ports/.env; DUI-F16 type-check examples in CI | `examples/`, CI | merged #453 #462 |
| E21 | DUI-F5 tool ctx.sessionId is the real session id (after E11) | `src/session`, `src/execution/toolCallExecution.ts` | merged #502; + #524 (EVE-0 lock), #533 (DUR-F11), #537 (fork) |
| E17 | CF-F1 deployed server channels use the durable store; CF-F2 `webhookChannel` on Fetch hosts | `src/deploy`, `src/channels/webhookChannel.ts` | F2 #451, F5 #456 merged; F7 merged #486 |

## Wave 3 — correctness (medium)

- **CORE-F3** synthetic prompts stay out of `messages`.
- **CORE-F4** no duplicate system prompt.
- **CORE-F5** `limits.maxSteps` takes the forced-answer path; `maxSteps` is validated.
- **CORE-F12 / PROV-F12** truncation reported as such, with no repair.
- **CORE-F8** generic `AgentApprovals`.
- **CORE-F9** reducer parts and endings.
- **CORE-F10** stream rethrows on error.
- **PROV-F5** clamp `Retry-After`.
- **PROV-F6** quota category.
- **PROV-F7** stream timeout only until the first chunk.
- **PROV-F8** error finish reason throws.
- **PROV-F9** `stop` and `toolChoice` sent.
- **PROV-F10** reasoning warning and the Fable regex.
- **PROV-F13** registry fallthrough and current defaults.
- **TOOLS-F6** grep ReDoS guard.
- **TOOLS-F7** refuse non-UTF-8 edits.
- **TOOLS-F8** `maxToolResultChars`.
- **TOOLS-F9** `/ui` role filter.
- **TOOLS-F10** `defineTool` schema lint.
- **TOOLS-F11** MCP approval default plus collision refusal.
- **TOOLS-F14** ACP null line.
- **TOOLS-F17** sandbox `writeFile` confinement.
- **DUR-F4** `saveIf`.
- **DUR-F10** schedule sessions.
- **DUR-F11** poisoned turn.
- **DUR-F13** EPERM retry.
- **DUR-F14** SQLite busy.
- **DUR-F18** trigger body cap.
- **MA-F3** OTel parent retention.
- **MA-F6** handoff `toolSearch`.
- **MA-F7** cassette matching.
- **MA-F8** judge parsing.
- **MA-F10** span names.
- **MEM-F1** recall fail-open.
- **MEM-F4** corrupt memory file.
- **MEM-F5** compaction no-op.
- **CLI-F2 / F3 / F7 / F8 / F9 / F10.**
- **CF-F4…F8, F10, F13.**
- **Docs/UI findings** from `FINDINGS-docs-ui.md`.

## Wave 4 — product gaps (enhancements; need design)

- **PROV-F4** prompt caching.
- **PROV-F14** rate limiter.
- **TOOLS-F12** multi-approval per step.
- **TOOLS-F13 / DUR-F15** durable approval and pending listing, recover, SIGTERM drain.
- **TOOLS-F19** remember and edit-on-approve.
- **DUR-F17** durable flows.
- **CORE-F11** keep the user input on abort.
- **CORE-F13** per-call `maxSteps` and partial-object streaming.
- **MEM-F2** memory upsert/forget.
- **MA-F9** sub-agent trajectories.
- **MA-F13** skill files.
- **CLI-F4** package size.

## Owner-only

- **CLI-F1:** the `latest` dist-tag points at `alpha.0`. Fix with `npm dist-tag add @lousho/build-ai-agent@<ver> latest`. This needs the owner's npm credentials.

## Wave 3 progress log
- W3-PA PROV-F5 #471, PROV-F6 #480, PROV-F7 #490 — merged
- To check at final verification: `hostedTools.openrouter` / `reasoning.openrouter` tests failing on unexpected `reasoning-delta` chunk (seen on W3-PA branch); dist-dependent tests (importGraph, sharedChunks, registry kit) need `npm run build` first
- W3-CLI F8/F9/F10 #469, F2 #479, F3+F18 #483, F7 #488, F19 #493 — merged (follow-up: Cloudflare adapter tsup error handling)
- W3-D DUR-F18 #468, F14 #491, F20 #500, F10 #509 — merged (follow-up: stores.ts/SqliteStore.ts use transactionAsync after E4)
- W3-T TOOLS-F14 #473, F10 #485, F6 #498, F7 #503, F17 #514 — merged
- Follow-ups noted: LocalStorageCheckpointStore bytes encoding; stores.ts/SqliteStore.ts → transactionAsync; worker runtime delegate_to bypass; DUR-F9 KV approval claim (E14); E18/E19 studio, W3-PB, W3-M, W3-UI, W3-EX, W3-CH, W3-MCP, W3-MA, session follow-ups, W3-MEM were still running at usage cutoff — check `gh pr list --state all`.
- Not started: Wave 4 (product gaps), REPORT.md B14/B16/B17 correction, final full-suite + live harness re-verification on main.
- W3-PB PROV-F9 #481, F8 #506, F10 #510 merged; F13 #513 merged. Known pre-existing failures: hostedTools.openrouter / reasoning.openrouter tests (reasoning-delta/hosted-tool-call assertions) fail on main too
- W3-UI CORE-F9 #484 (+#497), CORE-F10 #508, CORE-F17 #517 — merged
- W3-M MA-F8 #482, MA-F7 #501, MA-F13 #519 (+#531) — merged
- W3-CH F7 #486, F6 #489, F11+F16 #496, F4 #526, F8+F13 #530, F10 #532 — merged; E17 F7 resolved by #486
- W3-EX CORE-F12 #492, F3 #518, F5 #522, F4 #525, F14 #534 — merged
- W3-MEM MEM-F1 #507, F4/F6/F7 #511, F5/F14 #515, F9/F11/F15/F16 #535, DUR-F13 #545 — merged (MEM-F9 docs-only; follow-up: fileMemory EPERM = MEM-F8)
- W3-MCP TOOLS-F11 #494, F18 #516, F8 #529, F9 #539 — merged
- W4 PROV-F14 rate limiter #541 — merged
- Main build broken by #519 + #537 (Worker bundle node: imports) — fixed by #555
- W4-DOCS DUI-F18 #536, F20 #540, F19 #543, F12 #546, F23 #548, REPORT.md B14\/B16\/B17 #549 — merged
- W4-TRAJ MA-F9 #560 (+ repeat/passAt) — merged
- W4-PKG F17 #550, F15 #557, F16 #558, F11 #559 (docs only; packages/create-loushy-agent is untracked leftover), F13 #561 (documented: undici forces node>=22.19), F4 #566 (llms-full.txt out of tarball, 4.60->4.27 MB) — merged. Open product calls: Agent Forge as separate package; relax undici to lower engines
- W3-STUDIO-UX DUI-F9 #547, F8 #552, F21 #565, F22 #568 — merged (open: dark-mode Save button contrast 3.67:1; llms-full.txt stale on main)
- W4-CACHE PROV-F4 #544 (cache pricing), #564 (promptCaching auto; live 9.6x cheaper on call 2) — merged. Follow-ups: sub-agents inherit promptCaching; loadAgentDir promptCaching key
- W3-MA MA-F3 #495, F10 #505, F6 #523, F15 #528, F12 #538, F14 #575, CORE-F7 #582 — merged
- W4-SESSION DUR-F4 saveIf #556, CORE-F11 keep input on Stop #579, DUR-F16 docs #583 — merged
- W4-MEM2 MEM-F13 #551, F10 #567, F8 #571, F2 #581 — merged
- W4-APPROVALS TOOLS-F13+DUI-F15 #554, DUR-F15 agent.pending() #572, TOOLS-F19 remember/args #585 — merged
- W4-FLOWS DUR-F17 checkpoint/resume #563, retry/timeout #578, approval pause #586 — merged
- W4-CALL CORE-F13 settings validation #570, per-call maxSteps/instructions #576, object.delta partial objects #584, CORE-F15 abort #587 — merged. Follow-ups: default stream-idle timeout; object.delta in AI-SDK UI stream; instructions in agent.json
- W4-MULTI TOOLS-F12 #591 core, #593 channels/routes — merged. All waves done; MAIN-HEALTH agent finishing CI-green + final verification
