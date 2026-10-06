# Agent landscape research — what people build, and with what harnesses

Compiled from three parallel web-research passes (coding-agent harnesses, non-coding
archetypes, orchestration/production patterns). Sources cited inline; primary sources
preferred.

## What people build (non-coding archetypes, ranked)

| # | Archetype | Why popular | Capabilities exercised |
|---|-----------|-------------|------------------------|
| 1 | Customer support (triage → answer → escalate → human handoff) | #1 primary use case in LangChain's 2025 survey (26.5%); canonical LangGraph/OpenAI SDK example | Classification/routing, structured output, read-vs-write tool split, HITL approvals, checkpointing, handoffs |
| 2 | Deep research (scope → parallel research → compress → cited report) | OpenAI/Anthropic/Perplexity shipped products; `open_deep_research` flagship | Orchestrator-workers fan-out, context compression, clarification loops, per-task model routing |
| 3 | RAG over company docs | Default first enterprise agent | Retrieval tools, citations, permission-aware retrieval, memory, groundedness evals |
| 4 | Email/Slack triage | Dominates n8n templates and Zapier case studies; "draft, don't send" is the trust sweet spot | Scheduled triggers, classification, per-sender memory, approval gates, model fallback |
| 5 | Text-to-SQL data analyst | Vanna 23.8k★, Databricks Genie | Schema introspection, read-only enforcement, structured output, audit |
| 6 | Document extraction/ETL | Quantifiable ROI (invoices ~$0.60 vs $12-15 manual) | Schema-enforced output, validation loops, confidence routing to humans |
| 7 | Browser automation | browser-use 108k★, Operator/Computer Use | Long-horizon loops, grounding, forced handoff on login/payment (via playwright-mcp) |
| 8 | AI SDR / outreach | Direct revenue attribution | Scheduling, CRM tools, long-horizon state, approval gates |
| 9 | Incident-response (SRE) | Azure/PagerDuty ship products | Webhook triggers, durable waits, risk-scored approval tiers, audit trail, verify-the-fix |
| 10 | Content pipeline (research → draft → critique → publish) | CrewAI's canonical demo | Evaluator-optimizer loop, role decomposition, quality gates, final human veto |

## What people build (coding-agent archetypes)

1. **PR reviewers / autofix bots** — most common; webhook → durable workflow → sandbox → branch + comments. "The AI part is surprisingly small — it's event-driven software with an LLM stage" (Amplitude).
2. **Issue triagers / bug reproducers** — Metabase Repro-Bot, Astro triagebot: reproduce → diagnose → verify → fix; labels as durable state.
3. **Large-scale migrations/codemods** — Airbnb (3.5K files), Google monorepo; per-file parallel steps + retries.
4. **Dependency-upgrade agents** — detect → changelog → codemod → isolated tests → PR.
5. **CI test fixers** — headless agent on failed-build events, constrained ("cannot delete tests").
6. **Chat-to-PR agents** — Slack orchestrator → disposable env → PR; reacts to review comments.
7. **Parallel-agent fleets** — git worktree isolation, atomic task claims, merge queues.
8. **Ralph-style autonomous loops** — `while ! done; do agent "$PROMPT"; done`, fresh context per iter, state in files/git.

## Standard orchestration patterns (Anthropic taxonomy + additions)

Augmented-LLM loop · prompt chaining · routing · parallelization (sectioning+voting) ·
orchestrator-workers/subagents · evaluator-optimizer · handoffs (Swarm-style, control
doesn't return) · agents-as-tools (manager pattern, control returns) ·
graph/state-machine workflows · HITL interrupts.

**What works vs fails:** parallel *readers* (research fan-out) work; parallel *writers*
clobber each other (Cognition). 68% of production agents run ≤10 steps inside *static
workflows* with human checkpoints (MAP study, 306 practitioners).

## Top harness features builders demand

1. Observability/tracing (89% adoption) · 2. HITL approvals (most-built pattern) ·
3. Structured output · 4. Durable execution/resumability (checkpoints ≠ durability) ·
5. MCP tool ecosystem (+ tool-overload mitigation: lazy tool search, per-agent tool
   subsets) · 6. Memory · 7. Streaming UI · 8. Evals (biggest demand gap — only ~19%
   have a CI gate) · 9. Guardrails · 10. Cost controls/shared budgets across subagents ·
11. Scheduling/triggers · 12. Multi-agent primitives.

## Coding-harness differentiators (recurring)

Tiered permissions enforced by harness not model · structured file editing
(search/replace diffs) · bash as universal tool · context-isolating subagents that
return summaries · plan mode / plan-execute split · verification loops (tests/LSP as
ground truth) · checkpoints/rewind · AGENTS.md instruction files · headless mode so the
same harness serves interactive devs AND CI-born archetypes · lifecycle hooks.

## Recurring pain points (our opportunity list)

- Approval fatigue → durable rule/policy stores beat per-action prompts (we have `permissions` rules + durable approvals)
- Compaction silently loses decisions (context engineering is the #1 job)
- Runs die at 2am; "recovery is heroism, not a workflow" (durable resume)
- HITL is primitive-level: nobody ships approval inbox/TTL/escalation chains
- Shared cost budget across subagent fan-out is "a subtle requirement most tools miss"
- MCP tool overload: 67-82k tokens of schemas before first message; needs tool subsets/lazy loading
- Verification is gameable: agents rerun flaky tests or weaken them; need declared run policies
- Evals lag observability badly

## Sources (selection)

- LangChain State of Agent Engineering: langchain.com/state-of-agent-engineering
- Anthropic Building effective agents; Multi-agent research system; Effective harnesses for long-running agents
- Cognition "Don't Build Multi-Agents" / "What's Actually Working"
- MAP study (agents in production): arxiv.org/html/2512.04123v2
- 12-Factor Agents: github.com/humanlayer/12-factor-agents
- OpenAI Practical Guide to Building Agents; Codex approval/sandbox docs
- Claude Code permissions/subagents/checkpointing docs; Cursor docs (subagents, shadow workspace)
- SWE-agent ACI paper arxiv.org/html/2405.15793v3; mini-SWE-agent/SWE-bench leaderboard
- Temporal/Pydantic durable execution docs; LangGraph checkpointers; CrewAI Flows
- MCP: modelcontextprotocol/servers, tool-overload studies, OWASP MCP threats

## Gap analysis vs. this SDK

**Already covered:** handoffs (`src/handoffs`), evals (`src/evals`: scorers, llmJudge,
trajectory, cassettes), memory slots + KV, subagents (task tool, background, resumable,
remote, piAgent), channels (Slack/Teams/Discord/Telegram/GitHub/webhook), schedules,
skills (progressive disclosure), AGENTS.md loading, context compaction, permissions
(allow/ask/deny + modes), durable approvals, cost caps/loop guards, checkpoints,
MCP client+server, deploy to node/docker/workers, tracing, spec files, kits.

**Thin or missing (to verify during replication):**

- Examples are minimal single-agent demos — none exercise the orchestration patterns
  people cite (orchestrator-workers fan-out, evaluator-optimizer, real handoffs,
  routing with structured decisions).
- No kit exercising channels + schedules + approvals together (the triage archetype).
- No risk-tiered approval example (the SRE archetype's signature).
- Approval TTL/escalation/reminders — research says nobody ships this; check ours.
- Shared budget across subagent fan-out — check whether cost cap propagates.
- Per-subagent MCP/tool subsetting — check.
