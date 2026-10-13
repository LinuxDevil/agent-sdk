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
| B14 | In-process `prompt` schedules never get a `sessionId` → ephemeral, undurable turns | medium | hostinger-monitor | **fixed** *(did not hold at first; fixed by Eve PR #509, schedules sessions)* |
| B15 | `SendOptions` lacks `parentSpanId` — `ExecuteOptions.parentSpanId` exists but unreachable via `createAgent().send()` | low–med | research-analyst | **fixed** |
| B16 | String `allow` prefixes on `createShellTool` accept arbitrary trailing args → can escape the workspace root | medium / security | coding-agent | **fixed** *(did not hold at first; fixed by Eve PR #452, shell allow-list)* |
| B17 | Legacy `input`/`prompt`/`args`/`result` span attrs are **on by default** — `fileTraceExporter` persists full prompts/tool results to disk | low / security | research-analyst | **fixed** *(did not hold at first; fixed by Eve PR #457, `redactContent` default)* |

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

## Eve-2 adversarial round — findings fixed and verified

A second adversarial pass audited the code the first round's fixes introduced (run leases, session paused markers, session-ownership claims, multi-approval pauses, streamed tool-call rewrites). Two independent audit agents plus repro scripts under `audit/eve2/repro/` confirmed **8 defects** (1 critical, 4 high, 3 medium); all are fixed on `main` and re-verified against the packed `1.0.0-alpha.19` tarball built at `edcf1ac4`.

| Finding | Severity | Fix PR | Packed-build re-verification |
|---|---|---|---|
| F1 session-ownership claim TOCTOU (two concurrent first-touch turns could both win an unowned session; a loser could stream inside a foreign session — cross-principal data exposure) | critical | #616 | `f1-session-squat-toctou.ts`: loser gets `403 LOUSHO_SESSION_FORBIDDEN`; post-claim read `400` — no leak |
| F2 `recordFailure()` poisoning a foreign checkpoint after lease loss | high | #617 | `f2-recordfailure-poisons-foreign-checkpoint.ts`: victim checkpoint untouched, `LOUSHO_PROVIDER_REQUEST_FAILED` intact |
| F3 paused-turn invisible when the `.paused` marker was never written (crash / ordering gap) | high | #617 | `f3-paused-marker-gap.ts`: `SessionAwaitingApprovalError` via checkpoint scan fallback |
| F4 edited args on a sub-agent's grouped approval skipped schema validation | high | #618 | `subagentGroupEditedArgs.ts`: invalid edit rejected, approval stays pending |
| F5 abort during a tool that ignores `AbortSignal` hung `send()`/`stream()`/`approvals.resolve()` forever | high | #618 | `abortDuringToolExecution.ts` and `abortDuringResumedTool.ts`: `finish=aborted` at ~670ms (150ms abort + bounded grace); near-complete tool results still kept |
| F6 re-paused grouped approval persisted only 1 of N approval ids | medium | #618 | `rePausedSubagentCheckpointIds.ts`: all pending ids in checkpoint |
| F7 streamed tool-call deltas repeating `id` without `index` fragmented one call into phantom calls | medium | #615 | `streamToolCallIdRewrite.ts`: repeated unindexed id stays one call |
| F8 any `"stream": true` substring in the request body (e.g. tool arguments) rewrote the JSON reply into SSE | medium | #615 | `streamRegexFalsePositive.ts`: JSON response preserved |

Triage of the round-1 corpus against current `main`: **142 of 166 findings verified fixed**; 15 remain open (mostly medium/low, documented per-cluster in `audit/eve/`); 9 reclassified.

## Real-task harness round — live OpenRouter, working key

All six harnesses re-run live on `main` (`06aaff6e`, alpha.19 packed build) with a working OpenRouter key, plus a new real-task driver and real-data modes.

| Harness | Result | Notes |
|---|---|---|
| `coding-agent` | **all PASS** | plan-mode denies incl. allow-matched writes; approval pause→resume in-process and cross-process; transcript survives "restart"; natural + manual compaction; `node --test` green |
| `companion` | **13/13 PASS** | memory store/recall across a process restart, slot separation, scope isolation, streaming reassembly |
| `incident-responder` | **all PASS** | signed webhook → parallel investigator fan-out → durable pause → HTTP approval → `restart_service` executed once → handoff → incident report |
| `hostinger-monitor` | **all PASS** | real endpoints (openrouter.ai catalog etc.) monitored by cron ticks; incident dedupe; durable incident log |
| `repo-maintainer` | **19/19 PASS** | signature rejects, typed review, approval-gated comment, `/approve` comment resolution |
| `research-analyst` | 1 harness-check failure (fixed) | see cost-accounting fix below |
| `products-admin` (**new**) | **all PASS** on `claude-haiku-4.5` | see below |

### `products-admin/` — a real greenfield build, not a canned bug

The coding-agent machinery (plan mode, approval-gated fs+shell, durable store, loop guard) pointed at a real objective: **scaffold a products admin dashboard CRUD** into an empty workspace — JSON-file store, `node:http` REST (`GET/POST/PUT/DELETE /api/products`), a single-page dashboard at `/`, and a `node --test` suite. The driver then boots the agent-built server itself and does the full CRUD over real HTTP (POST 201, list 200, get 200, PUT 200, DELETE 204, dup-sku 400, missing 404, dashboard page serves and calls the API). With `openrouter/anthropic/claude-haiku-4.5` it went fully green: 15 agent-written tests passing, all 7 harness checks.

**Honest finding — model tier matters for open-ended builds.** The default `gpt-4o-mini` passes every bounded harness but could not finish this task: it wrote `./store.js` specifiers against `.ts` files, shadowed `fetch` into infinite recursion, imported a nonexistent `node-fetch`, and burned steps re-running an identical failing command until the loop-guard denied it. The SDK held up throughout — plan-mode denials, approvals, the loop-guard hook, and durable state all behaved correctly; this is a model-capability limit, and `AUDIT_MODEL` selects a stronger model for build tasks. Set `AUDIT_MODEL=openrouter/anthropic/claude-haiku-4.5` (or stronger) when running `products`.

### Real-data modes for the other harnesses

- `REPO_FIXTURE=<dir>` — `repo-maintainer` reviews a real checkout + diff instead of the canned cart-service. Verified with `repo-maintainer/real-fixture/` (the real merged PR #616 diff + its files at PR head): the reviewer produced a coherent typed review (verdict `approve`, 2 file-referenced nits) through the full webhook→pause→approve→comment pipeline.
- `CORPUS_DIR=<dir>` — `research-analyst` researches real documents. Verified with `CORPUS_DIR=../docs` (64 real SDK docs) and a real question on approvals/resume/cost: 9 parallel researchers, cited report, all checks green.
- `INCIDENT_TELEMETRY=<file.json>` — `incident-responder` investigates real telemetry. Verified with `incident-responder/real-telemetry.json` built from actual run logs + real git history: the commander correctly diagnosed a crashed service and requested `restart_service` with a sound reason.
- `hostinger-monitor` and `companion` are inherently real already (live HTTP endpoints; a live multi-turn conversation with durable memory).

### Harness fix this round (not an SDK defect)

`research-analyst` usage check demanded `sum(costUsd) === estimateCost(aggregate)` exactly. With a provider that bills per call (OpenRouter `usage.cost` applies prompt-cache discounts), the equality is wrong-headed: the billed sum is *better* than a fresh estimate. The check now re-estimates with `cachedInputTokens` included and allows a 15% band for billed runs (exact equality still required when nothing was billed). Verified live: `sum=$0.018895` vs `estimate=$0.018895` on the real-docs run (1152 cached input tokens).

## Replicated real-world harness patterns — live OpenRouter

A survey of what teams actually ship (G2/Salesforce/OpenAI/Google Cloud agent reports + reference implementations — see `TRENDS.md`) produced three new harnesses replicating the dominant production patterns:

| Harness | Replicates | Result |
|---|---|---|
| `sdr-outreach/` | AI-SDR "drafts-as-pull-requests" (Arvexi/Reply.io/Mesh Pilot): enrichment → personalized draft → **durable approval queue** → reject-with-feedback redraft → separate sender principal (per-agent tool allowlists) → CRM log + audit trail | **8/8 PASS** on gpt-4o-mini — 27 approval pauses resolved, only approved drafts sent |
| `data-analyst/` | "Talk to your data" text-to-SQL (OpenAI cookbook + pi-sql-analytics): sqlite SaaS warehouse, schema tools, `run_query` behind a **deterministic SELECT-only guard outside the model**, metric definitions + durable corrections, query audit log | **8/8 PASS** on claude-haiku-4.5 (see finding below) |
| `eval-loop/` | Generator↔evaluator harness pattern: builder + hostile reviewer with **disjoint sessions**, 5-predicate contract + typed rubric, deterministic 4-round control loop (continue/stop/escalate) | **6/6 PASS** on gpt-4o-mini — converged round 2, canary isolation clean |

**Findings from the replication runs:**

- **Model tier matters for analytic tasks too** (extends the products-admin finding): gpt-4o-mini answered "$3,599" for a $4,673 MRR question (took the top plan's slice as the total) and cited account IDs instead of names; claude-haiku-4.5 produced correct, fully-cited answers. Bounded flows (sdr, eval-loop) pass on mini; anything requiring correct multi-step SQL/joins wants a stronger model.
- **Harness enhancement made**: `data-analyst` initially relied on an instruction ("describe_table before querying") that both models ignored. Following the replicated pattern's own principle — *deterministic enforcement outside the model, not prompt instruction* — `run_query` now refuses (advisory verdict) statements referencing undescribed tables. Both models were then bounced correctly (`advised-aways=3` on haiku; the pattern, not the prompt, enforces order).

No SDK defects surfaced in this round — approvals, durability, sub-agent isolation, structured output, and tool-gating all behaved correctly across 27+ approval pauses and ~40 tool calls.

