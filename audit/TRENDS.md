# What agents are people actually building — and the harnesses behind them

Surveyed: G2 AI Agents 2025 report, Salesforce Agentic Enterprise Index (H1 2025), OpenAI State of Enterprise AI, Google Cloud ROI-of-AI study, plus reference implementations (Arvexi SDR architecture, OpenAI cookbook data-analyst, pi-harness SQL analytics, access-aware text-to-sql, "harness-centric design for long-running agents" notes).

## Top use cases (by adoption)

| Rank | Use case | Our coverage |
|---|---|---|
| 1 | Customer service (avg daily agent-led conversations +70%/mo — Salesforce) | `support-desk/`, `companion/` |
| 2 | Software development (Codex, Claude Code — end-to-end code gen/refactor/test) | `coding-agent/`, `products-admin/`, `repo-maintainer/` |
| 3 | Internal/business automation (HR, procurement, IT ops) | `incident-responder/`, `hostinger-monitor/` |
| 4 | Research & BI ("talk to your data") | `research-analyst/`, **`data-analyst/` (new)** |
| 5 | Sales outreach (draft outreach, follow-ups, meeting requests — most-common agent action) | **`sdr-outreach/` (new)** |
| 6 | Marketing content | **`eval-loop/` (new)** — content produced under a graded contract |

## The harness patterns that show up everywhere

1. **Drafts-as-pull-requests** (Arvexi SDR, Mesh Pilot, Reply Jason): the agent can *draft* but never *send*; every outbound artifact goes through a human approval queue; rejections carry feedback that produces a redraft; a different principal/tool-allowlist owns sending. Hard tool allowlists per agent — security by default, not prompt instruction.
2. **Deterministic guards outside the model** (OpenAI data-analyst, pi-sql-analytics, access-aware text-to-sql): the model proposes SQL/commands; a non-LLM guard enforces SELECT-only, single-statement, row caps, schema whitelists. No prompt can talk it out of a decision. Honest-incompleteness labels (FULL/SCOPED/INCOMPLETE) when access limits the answer.
3. **Generator ↔ evaluator loops** (harness-centric design notes, eval-engineering literature): disjoint contexts — the grader must never share the generator's context (shared-context grading converges on sycophancy); a contract C of *testable predicates* decides "done"; a control policy u maps verdicts → {continue, restart, stop, escalate}.
4. **Eval layers over pass/fail**: outcome-based grading (final state, not execution path), pass@k vs pass^k, trajectory auditing for safety.

## Replications built here

- `sdr-outreach/` — pattern 1 end-to-end: enrichment → personalized draft → durable approval pause → feedback redraft → separate sender principal → CRM activity log + audit trail.
- `data-analyst/` — pattern 2: sqlite SaaS warehouse, schema tools, `run_query` behind a deterministic SELECT-only guard (no approval prompt — the guard IS the boundary), metric definitions + durable corrections memory, query audit log.
- `eval-loop/` — pattern 3: builder + hostile evaluator with disjoint sessions, 5-predicate contract + rubric, deterministic 4-round control loop, canary check for context isolation.

Run them from `audit/`: `npx tsx sdr-outreach/index.ts` / `data-analyst/index.ts` / `eval-loop/index.ts`.
