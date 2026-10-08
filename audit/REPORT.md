# Audit report — @lousho/build-ai-agent

Real-world audit: six consumer harnesses built against the **packed alpha.18 tarball** (the real install path) and run **live** against OpenRouter (`openai/gpt-4o-mini`), plus an earlier local-LLM (LM Studio) audit pass on the same tarball. Each harness has its own `FINDINGS.md` with repros; this file is the triage view.

> **Status (merged with `main`):** all 17 bugs fixed and verified. Where upstream audit-fix branches landed the same finding first, the merged implementation names differ slightly — noted as *(upstream)* below. The branch's distinct fixes: namespaced memory keys, cold-process approval→session rebinding, `LOUSHO_SESSION_BUSY` optimistic concurrency, workspace-escaping path rejection for string `allow` patterns, and OpenRouter `metadata.raw` upstream detail.

## The harnesses

| Harness | Real-world scenario | Surfaces stressed | Result |
|---|---|---|---|
| `coding-agent/` | Mini Claude-Code: read/plan/approve/edit/test a scratch repo | workspace fs+shell, plan mode, approvals, sessions, restart-resume, compaction | PASS (12 findings) |
| `hostinger-monitor/` | VPS/service watchdog with cron ticks | defineTool HTTP, schedules, durable incidents, structured output, Hostinger API | PASS (6 findings) — real Hostinger API 200 |
| `companion/` | Persistent AI companion (memory + dynamics) | persona, `defineMemory` scoping, session resume, streaming, dynamics state | PASS (5 findings) — recall survived restart |
| `incident-responder/` | On-call: webhook → investigate → approve fix | webhook HMAC, subagent fan-out, typed decisions, approval-gated remediation, handoff | PASS (6 findings) — pause→approve→resume over HTTP |
| `repo-maintainer/` | GitHub PR review bot | `X-Hub-Signature-256` verify, fs tools, structured review, approval-gated comment, tool search, skills | PASS (8 findings) — 19/19 checks |
| `research-analyst/` | Deep-research pipeline | waves fan-out, verify+extend, structured report, usage/cost rollup, OTel traces, evals | PASS (5 findings) — cost accounting exact |
| `support-desk/` (earlier) | Durable customer-support agent | handoffs, durable turns, concurrent HTTP, approvals over routes | 13 findings incl. 5 high |
| `log-incident/` (earlier) | Durable log analyzer | resume, compaction, replay | ~12 findings |
| `_cross/` (earlier) | Packaging/providers/local-model fit | tarball, zod4 dts, OpenAI-compatible endpoints | X1–X6 |

## Confirmed bugs — fixed or fixable now

| # | Finding | Severity | Harness | Status |
|---|---|---|---|---|
| B1 | Session-paused approval resolved from a restarted process **silently deletes the whole turn** (`createAgentApprovals.ts:285` bare-resume fallthrough) | high | coding-agent | **fixed** |
| B2 | Two `defineMemory` slots on one scope key **silently share a bucket** — slot name isn't in the storage key (`withMemory.ts:21`) | high | companion | **fixed** |
| B3 | `output` schema with any optional field → provider **400** on strict endpoints: `closeObjectSchemas` sets `additionalProperties:false` but not full `required` (`structuredOutput.ts:78,119`) | high | repo-maintainer | **fixed** |
| B4 | Via `createRouteHandler` a customer can **approve their own gated refund** — no approver-vs-principal split on the route | high / security | support-desk | **fixed** *(upstream: `authorizeApproval`/`authorizeSession` + 404 session↔approval binding; default lets the run's own user confirm their call — supervisor policies are opt-in)* |
| B5 | Two concurrent HTTP requests on one session: **last write wins, a turn is silently dropped** | high | support-desk | **fixed** (`LOUSHO_SESSION_BUSY`) |
| B6 | Approval continuation failure **erases the already-executed approved tool call** from the session | high | support-desk | **fixed** |
| B7 | Handoff routing note is injected as a mid-conversation `system` message → **breaks Qwen/Llama chat templates** | high | support-desk | **fixed** *(upstream: folded into leading system prompt)* |
| B8 | llama.cpp/LM Studio context-overflow (HTTP 500 `exceed_context_size_error`, "context size has been exceeded") classified `unknown`+retryable → retries a deterministic failure | high | _cross / log-incident | **fixed** *(upstream)* |
| B9 | Unknown models silently assume **128k** context window (compaction + tool search) — 15× over a real 8k local window | high | _cross | **fixed** *(upstream: warn-once + `registerModel()`/`contextWindow` override)* |
| B10 | `approvals.get('bogus id!')` throws `LOUSHO_CONFIG_INVALID` instead of documented `undefined` | low | incident-responder | **fixed** |
| B11 | `fireSchedule` implemented (`src/schedules/`) but never exported — no supported "run schedule now" | low–med | hostinger-monitor | **fixed** |
| B12 | `CompactedLLMProviderError` drops the upstream body — real provider message hidden (`responseBody:undefined`) | medium | repo-maintainer | **fixed** |
| B13 | Finished session turns delete checkpoint **and** history → `agent.fork` can't branch them (asymmetric with `send()` runs) | low | incident-responder / companion F5 | **fixed** |
| B14 | In-process `prompt` schedules never get a `sessionId` → ephemeral, undurable turns | medium | hostinger-monitor | **fixed** |
| B15 | `SendOptions` lacks `parentSpanId` — `ExecuteOptions.parentSpanId` exists but unreachable via `createAgent().send()` | low–med | research-analyst | **fixed** |
| B16 | String `allow` prefixes on `createShellTool` accept arbitrary trailing args → can escape the workspace root | medium / security | coding-agent | **fixed** |
| B17 | Legacy `input`/`prompt`/`args`/`result` span attrs are **on by default** — `fileTraceExporter` persists full prompts/tool results to disk | low / security | research-analyst | **fixed** |

## Enhancements — shipped by the merged fixes

- ~~`webhookChannel` pause response drops the computed `approvalPrompt`~~ → now carries the text (incident F3)
- ~~`remember_<name>` input is fixed `{text}`~~ → `defineMemory({ itemSchema })` types the input, stores canonical JSON + `metadata` (companion F2)
- ~~No dedupe on memory items~~ → `add()` dedupes identical `text` per scope across all built-in providers (companion F3)
- ~~`githubChannel` ignores `pull_request.opened`~~ → `githubChannel({ pullRequestOpened: true })` (repo E2)
- ~~`parentSpanId` unreachable~~ → `send()`/`stream()` accept it (research F1)
- ~~`OpenAIProvider({baseURL})` only calls `/responses`~~ → `api: 'chat'` for OpenAI-compatible servers (X3)
- ~~Cron prompt turns were ephemeral~~ → durable `schedule-<name>` sessions when checkpoint storage exists

## Enhancements still open (documented, not fixed this pass)

- `approvals.list()` is process-local; no durable pending-approval enumeration (coding F3)
- `session.pending()` reports but doesn't bind the pause (coding F2)
- Plan mode has no read-only shell affordance — can't `node --test` while planning (coding F4)
- Cron is minute-granularity only — no seconds/`@every` (hostinger F3)
- `webhookChannel` has no first-class `sessionId` mapping (incident F5)
- `toolCalls` on ExecutionResult uses wire shape `function.name` vs event `toolName` (incident F6)
- No upsert/`forget_*` on memory items; recall is loose OR keywords (companion F4)
- `tool_search` `{loaded:[], more:N}` invites model fishing (repo E1)
- `decide()` unreachable via OpenRouter (OpenAI `gpt-6-luna` endpoint only) — the `output`-schema path is the portable form; document prominently
- No `openai-compatible/` or `lmstudio/` provider spec; local models need a dummy `OPENAI_API_KEY` (X4)
- Shipped `.d.ts` built against zod 3 fail under zod 4 with `skipLibCheck:false` — annotate exported schemas as `z.ZodType<T>`; add a zod-4 `tsc` pack-smoke step (X5)
- `cost` is `undefined` (unpriced) vs `$0` (free) — indistinguishable for local models (X6)
- Repeated identical tool calls each demand fresh approval — no "don't ask again" (coding F7)
- `ExecutionResult.messages` on session turns is cumulative — "this turn" filtering needs a slice (research F4)
- Mutating `ctx.messages` inside `preToolCall` breaks tool_call/tool_result pairing → 500 (repo F3) — document or guard
- llmJudge-verifier re-flagging covered gaps, background `agent_status` polling loops — small-model variance, not SDK bugs

## What the audit proved works

- **Durable approval over HTTP**: pause → signed approval POST → resume → tool executes exactly once — across `webhookChannel`, `githubChannel`, and session restart (`fileStore`/`SqliteStore`)
- **Restart-safe sessions**: `sessionId` + store → new process resumes transcripts, pending turns, and approvals; `SessionAwaitingApprovalError` carries what's needed
- **Sub-agent isolation**: same-named tools in different sub-agents stayed isolated; parallel `task` calls overlap in wall-clock
- **Cost accounting is exact**: `delegated.runs`/`stepUsage`/`byModel` reconcile to 1e-9 against `estimateCost`
- **Channel verification**: Slack/GitHub/webhook signatures all reject bad/missing/tampered (401); replay windows enforced
- **Plan mode**: denies writes including `allow`-matched mutations; rule.index audit trail intact
- **Workspace confinement**: symlink/realpath battery clean on Windows
- **Structured output**: `output` schema enforced + validated on OpenRouter (with the B3 caveat on strict providers)
- **`toolSearch`/skills progressive loading**, **streaming events** (text.delta reassembly === text.done), **OTel JSONL traces**, **cron schedules** fire/re-arm correctly

## Live revalidation — alpha.19 tarball (post-fix sweep)

All harnesses re-run against a freshly packed `1.0.0-alpha.19` built from `main` after PRs #433, #439–#443 merged.

| Harness | Result | Notes |
|---|---|---|
| `incident-responder` (OpenRouter) | **20/20 PASS** | `resume()` on an awaiting-approval session checkpoint correctly throws `SessionAwaitingApprovalError`; `approvals.get(<bad id>)` returns `undefined` (E4 verified live); durable pause → HTTP approval → resume → handoff → report all pass |
| `repo-maintainer` (OpenRouter) | **19/19 PASS** | webhook signature checks, PR review flow, approval gate + resolution |
| `coding-agent` (OpenRouter) | **all PASS** | plan-mode denies (incl. allow-matched), in-process + cross-process approval resume, transcript survives "restart", natural + manual compaction, workspace checkpoints |
| `companion` (OpenRouter, `--fresh`) | **13/13 PASS** | facts stored under namespaced `user_facts#<scope>` keys; injection block present; slot separation; scope isolation; dynamics evolve; cross-restart recall |
| `research-analyst` (OpenRouter) | **all PASS** | 2-wave fan-out, clean-context isolation, structured report, exact cost accounting, OTel traces, llmJudge |
| `hostinger-monitor` (OpenRouter + live HTTP) | **all PASS** | two ticks across simulated restart, incident dedupe, durable incident log |
| `support-desk` (LM Studio qwen3.5-9b) | scenarios all exercised | cross-process approval resume, `LOUSHO_APPROVAL_FORBIDDEN` for wrong principal, namespaced per-customer memory isolation, SSE event validity, disconnect keeps committed turn (B4 live). Self-approval by the requester returns 200 — upstream `callerOwnsApproval` default; `authorizeApproval` is the opt-in for stricter policy |
| `log-incident` (LM Studio 8K window) | run reached `max-steps` | model-capacity outcome, not an SDK defect; compaction two-phase→prune fallback, `appliedStrategy`, `prunedToolCallIds`, summarizer error passthrough, and the `agent.resume` retry loop all exercised live |
| `invoice-extract` (LM Studio) | partial | successful docs extract + validate + route correctly (`auto` vs `awaiting-approval`, `tax_math` flags); remaining docs hit the harness's own 240s per-doc timeout on the shared 9B model — timeout machinery itself works (`aborted` via per-request `AbortSignal`) |
| `docs-qa` (LM Studio) | ran | a weak-model reply that echoed the JSON Schema was correctly rejected as `output-invalid` ("the reply is the JSON Schema, not data") — the schema-echo guard fires as designed. A rerun after #445 verified D3 live: with `maxSteps: 2` spent on tool calls, the forced no-tools answer call produced a valid `object` (`finishReason: 'max-steps'`, `object` populated, `outputError: null`) |

**Harness fixes made during revalidation** (harness bugs, not SDK bugs):

- `companion/index.ts`: memory dumps listed the raw scope key while items live under `memoryKey(slot)` (`<slot>#<scope>`); switched to `memoryKey()` so store/separation/isolation checks read real buckets.
- `incident-responder/index.ts`: the resume-refusal check now logs the actual thrown error (or resolved value) for diagnosis instead of a bare `unexpected`.
