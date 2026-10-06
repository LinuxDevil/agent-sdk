# Agent replication plan — building the archetypes people actually build

Companion to `agent-landscape-research.md`. Approved scope: all six deliverables below,
built on `integration/harnesses`, each with an offline mock-provider test following the
`examples/coding-harness` convention. Builders report SDK gaps/frictions; SDK fixes are
made separately after review.

| # | Deliverable | Form | Archetype | SDK surface proven |
|---|-------------|------|-----------|-------------------|
| 1 | `deep-research` | example | Orchestrator-workers: lead fans out parallel researcher subagents, compresses, cited report | `subagents` + `task`, parallel readers, per-subagent tools |
| 2 | `inbox-triage` | registry kit | Channel intake → classify → draft → approval → send; per-sender memory | `channels/`, `schedules/`, `memory/` dirs, `permissions` ask rules |
| 3 | `incident-response` | registry kit | Webhook alert → diagnose → risk-tiered approval → remediate → verify | risk-tiered `permissions`, `approve` hook, audit |
| 4 | `support-desk` | example | Classify → answer → `handoff` to billing/tech agent (control transfers) | `handoffs`, `handoffFilters`, structured routing |
| 5 | `evaluator-loop` | example | Writer ↔ critic (`llmJudge`) revise-until-pass loop | `evals` module, evaluator-optimizer |
| 6 | `data-analyst` | example | Text-to-SQL over SQLite: schema introspection, read-only enforcement | structured output, tool gating, permissions |

## Rules for builders

- Mock provider by default (`createMockProvider`/`mockModel`); live path via
  `OPENROUTER_API_KEY` where it adds value (like `coding-harness`).
- Each builder owns ONLY its directory (`examples/<name>/` or `registry/<name>/`).
  Shared files — `examples/README.md`, `registry/dist`, `defaultRegistry.test.ts`,
  `CHANGELOG.md`, docs — are integrated by the coordinator.
- Verify with `node --test <own test file>` + lint own files only; full suite runs
  after integration.
- **Report every SDK gap, awkward API, missing option, or workaround** — that report
  drives the fix/enhance phase.

## SDK probes (verified during or after builds)

- Approval TTL / escalation / reminders (research: nobody ships this — differentiator)
- Shared `maxCostUsd` across a `task` fan-out (subtle requirement most tools miss)
- Per-subagent tool subsets (MCP tool-overload mitigation)
- `interrupt`-style resume semantics for channels/schedules

## Gap triage (from builder reports)

**Confirmed real gaps → fix:**

1. **Approvals never expire** — `PendingApproval` has `createdAt` but no TTL/deadline;
   `settle` waits forever (`createAgentApprovals.ts`). Nobody in the industry ships
   approval TTL/escalation → differentiator. Add `ttlMs`/`expiresAt` + expiry outcome.
2. **`llmJudge()` discards judge feedback** — it prompts "no explanation" and drops
   `reason` (`llmJudge.ts:34-44,95`), so revision loops can't get "why it failed".
   Add opt-in critique mode returning `{ score, feedback }` (new helper or config flag).
3. **Handoff `transfer_to_*` calls bypass the permission gate** — split out before
   `runToolBatch` (`AgentExecutor.ts:~1260`); `deny`/`ask` on transfers do nothing and
   no `onPermissionDecision` audit entry fires. Route transfers through the gate.
4. **Handoff target's `approve`/`approvalStore` silently ignored** — approvals bind to
   the starting agent's run (`handoffAgents.ts` `asTarget` doesn't forward them).
   Silent no-op on a security option → forward or warn.
5. **Structured handoff args never reach the target** — `input` args visible only to
   `inputFilter`/`onHandoff` (`handoffRun.ts:262-281`). Pass them through as a routing
   note / context by default (Swarm `context_variables` equivalent).
6. **`testToolContext()` helper** — `ToolExecutionContext` needs `toolCallId`, `messages`,
   `getToken`, `requireAuth` stubs for direct `tool.execute()` unit tests
   (`src/types/tool.ts:45-95`). Two independent builders hit this → add to `src/testing`.
7. **`toolResultOf()` unwrap helper** — tool results land JSON-encoded in transcripts;
   every consumer hand-rolls `JSON.parse` (`toolResult.ts:14-16`). Export a helper.
8. **Webhook `principal`** — `webhookChannel.parse` maps only input/sessionKey/replyTo;
   the alerting system's identity can't reach `when` filters or audit attribution.
9. **Numeric `when` matchers in agent.json** — only `{arg: regex}` exists, AND-only;
   `replicas <= 10` needed a `^([1-9]|10)$` hack. Add `gt/gte/lt/lte` arg matchers.

10. **No durable approval store declarable in `agent.json`** — `store`/`approvalStore`
    aren't config keys (`validateConfig.ts:86-102`), so a paused `send_reply` lives in
    `InMemoryApprovalStore` and dies with the process. "Draft today, human approves
    tomorrow" is THE triage archetype — add a declarable file-store path.
11. **`ApproveToolCall` can't abstain** — `boolean | string` verdicts only; a wired
    `approve` decides EVERY pause, no "auto-decide the safe ones, defer the rest to a
    human". Add a `'defer'` verdict that leaves the approval pending.
12. **`ChannelInbound.metadata` never reaches the run** — `channelCore.ts:191` drops it;
    only `principal` crosses. Forward it into `SendOptions.metadata` so memory scopes
    and `when` filters can key on channel-supplied context (e.g. alert source).
13. **`webhookChannel.parse` can't set `principal`** — map inbound auth/sender identity
    so `when` can gate on it and audit can attribute the run.
14. **`preToolCall` re-fires on approval-resume with no "approved re-run" flag** —
    stateful hooks (loop guards, audit) count an approved call twice
    (`resume.ts:723-756`). Add a flag to the hook context.
15. **Overrides can't remove dir-wired `approve`/`hooks`** — `undefined` falls back to
    the directory file; add a `null`/`false` strip sentinel in `loadAgentDir`.
16. **Per-run memory tools trip `onAgentDrift` on every approval resume** — cosmetic
    warn noise; silence when only per-run tool identity changed.

**Document as known limitations (bigger than this round):**

- `when` can't validate args against live state (model-claimed args only) — tools must
  enforce their own floor, which is correct-by-design; document it.
- Approval quorum/routing/required-role; incident-scoped permission modes;
  "approve once/for-session" scopes; per-message memory scopes — roadmap items.
- Sub-agent fan-out observability hooks (`onSubagentStart/End`, task timing metadata).
- `examples/` outside `tsconfig.tests.json` coverage; `MockRequest` doesn't record
  emitted responses; registry build bundles test files (needs `exclude`/`files`).

**Verified already-covered (no fix needed):**

- Shared budget: sub-agent usage rolls into lead totals (LOU-V5), so run-level
  `limits.maxCostUsd` bounds the fan-out.
- `when` regex-arg matching exists declaratively (`{ arg: "regex" }`) and as code
  predicates; per-subagent tool subsets exist by construction (each sub-agent is a
  `createAgent` with its own `tools`).
