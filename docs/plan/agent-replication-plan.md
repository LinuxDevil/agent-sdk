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
