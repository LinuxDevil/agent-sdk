# Examples

Runnable examples of `@lousho/build-ai-agent` in use. Each directory below
is runnable directly (see its own README for exact instructions); most use
`tsx` and a free mock provider by default, so nothing here needs an API key
to try.

## [agent-dir](./agent-dir)

An agent defined as a directory (`instructions.md`, `tools/`, `skills/`, `agent.json`) and loaded with `loadAgentDir()`; runs offline with a mock model (LOU-Y5).

## [coding-harness](./coding-harness)

A coding-agent harness: a broken `add()` fixture the agent must fix under a guard (test files are refused), with a loop guard, checkpoint rewind and per-family instructions; runs offline with a mock model. `kit.test.ts` installs the same harness as the `coding-kit` registry item and builds it into a node-server deployment (H1).

## [data-analyst](./data-analyst)

Chat-with-your-database (the Vanna/Databricks Genie archetype): the agent introspects the schema, writes SQL and answers with real rows — with defense-in-depth read-only enforcement (tool validation plus a permission rule), so `DELETE`/`DROP` can never run. `node:sqlite`-backed; runs offline with a mock model.

## [deep-research](./deep-research)

The deep-research archetype (Anthropic's multi-agent research shape): a coordinator decomposes a question and fans out parallel `task` calls to a researcher sub-agent — parallel readers, compressed summaries back — then synthesizes a cited report. Runs offline on an in-memory corpus; proves real fan-out concurrency.

## [doc-qa](./doc-qa)

A question-answering agent scoped to a single fixed document (LOU-H10).

## [evaluator-loop](./evaluator-loop)

The evaluator-optimizer pattern (CrewAI's writer/critic shape): a writer drafts, `llmCritique()` scores the draft against a rubric and returns actionable feedback, and the draft is revised until it passes or `maxRounds` is hit. Runs offline with mock models.

## [openrouter](./openrouter)

Runnable snippets showing `OpenRouterProvider` usage: generation, streaming, tool calling, model listing and more (LOU-B6). Needs `OPENROUTER_API_KEY`.

## [ops-pipeline](./ops-pipeline)

A flagship end-to-end pipeline: a Grafana/Datadog monitor delegates a fix (behind a real
human approval gate, with a Slack "Fix it" button) to a fixer agent, whose patch is
guardrail-gated before a GitHub PR is opened (LOU-J4-J9).

## [plan-mode](./plan-mode)

Plan first, then edit: a coding agent in `plan` mode reads and proposes, then `session.setPermissionMode('acceptEdits')` lets it apply the plan; runs offline with a mock model (N4).

## [research-assistant](./research-assistant)

A research agent with the built-in `http` tool wired up (LOU-H10).

## [slack-notifier](./slack-notifier)

Turns a raw event description into a short, Slack-ready notification (LOU-H10).

## [support-bot](./support-bot)

A minimal, empathetic customer-support agent (LOU-H10).

## [support-desk](./support-desk)

The production support archetype: a triage agent classifies the request and `handoff()`s the whole conversation to a billing or tech-support specialist — control transfers, unlike a sub-agent whose result returns. Approval-gated refund tool, structured handoff args, and hand-back routing; runs offline with mock models.

## [tracing](./tracing)

Runnable examples of `AgentExecutor.execute()` wired to console and OpenTelemetry trace exporters (LOU-E6).

## [workflow-router](./workflow-router)

An agent that classifies an incoming request into a fixed set of categories (LOU-H10).
