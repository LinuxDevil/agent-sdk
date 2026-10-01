# Examples

Runnable examples of `@loushy/build-ai-agent` in use. Each directory below
is runnable directly (see its own README for exact instructions); most use
`tsx` and a free mock provider by default, so nothing here needs an API key
to try.

## [agent-dir](./agent-dir)

An agent defined as a directory (`instructions.md`, `tools/`, `skills/`, `agent.json`) and loaded with `loadAgentDir()`; runs offline with a mock model (LOU-Y5).

## [doc-qa](./doc-qa)

A question-answering agent scoped to a single fixed document (LOU-H10).

## [openrouter](./openrouter)

Runnable snippets showing `OpenRouterProvider` usage: generation, streaming, tool calling, model listing and more (LOU-B6). Needs `OPENROUTER_API_KEY`.

## [ops-pipeline](./ops-pipeline)

A flagship end-to-end pipeline: a Grafana/Datadog monitor delegates a fix (behind a real
human approval gate, with a Slack "Fix it" button) to a fixer agent, whose patch is
guardrail-gated before a GitHub PR is opened (LOU-J4-J9).

## [research-assistant](./research-assistant)

A research agent with the built-in `http` tool wired up (LOU-H10).

## [slack-notifier](./slack-notifier)

Turns a raw event description into a short, Slack-ready notification (LOU-H10).

## [support-bot](./support-bot)

A minimal, empathetic customer-support agent (LOU-H10).

## [tracing](./tracing)

Runnable examples of `AgentExecutor.execute()` wired to console and OpenTelemetry trace exporters (LOU-E6).

## [workflow-router](./workflow-router)

An agent that classifies an incoming request into a fixed set of categories (LOU-H10).
