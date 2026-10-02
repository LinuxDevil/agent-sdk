# Round 2 plan

Built from [AUDIT-2.md](AUDIT-2.md) on 2026-10-02. Not started: the owner decides whether and when to run it. Tickets are 1 point each (one pull request, one agent), in the style of round 1. "Breaking" means a CHANGELOG entry with a migration note is required. "Owner" means the ticket changes publish or release configuration, or needs an account, and must be confirmed first.

Goal of the round: make every ✅ in the matrix true without an asterisk, make the first hour match the README's promise, and close the integration gap to eve. The order of the waves is the order of value: wave 0 and 1 change what a new user sees this week; wave 2 is parity on claims already made; wave 3 is new capability; wave 4 is the pre-1.0 cleanup.

## Wave 0: after the first publish (small, do first)

| Id | Ticket | Notes |
|---|---|---|
| R1 | Verify the published packages from the registry: `npm create lousho-agent`, `npx lousho doctor`, ESM and CJS import, `lousho studio`, on Node 22 and 26 | Add a `registry-smoke` script next to `pack-smoke`; run it in CI on a schedule |
| R2 | Export the Cloudflare KV store (`@lousho/build-ai-agent/kv`) and add `fileStore(dir)`, a ready-made file `AgentStore` | Fixes the "Durable stores" row; `docs/deployment.md` tells users to import a class that has no import path |
| R3 | Stale-lock fix in `buildLock.testkit.ts`: detect a dead owner by PID, not by a 3-minute age | One native vitest crash currently turns the next run red |
| R4 | Tarball diet: exclude the 15 test-only files; decide on shipping `src/` and source maps (47% of 11.7 MB) | **Owner** (`files` is publish config) |
| R5 | Sync automation: a workflow in `agent-sdk-docs` that runs `npm run sync` when the SDK's `docs/` change and opens a pull request; `check-translations` in CI flags stale Arabic pages | The site is generated; today the sync is a manual command |
| R6 | **Done (#184, #185).** README truth pass: install commands that agree with `docs/installation.md`, the full CLI list, `createAgent({ store })` and `compaction` in the feature list, a Status section with the real limits, no links to files that do not ship | |

## Wave 1: the first hour (docs and surface)

| Id | Ticket | Notes |
|---|---|---|
| G1 | Rewrite `docs/quick-start.md` around `createAgent()`: hello, a tool, streaming, a session, an approval, a test with `mockModel`. Move the executor section to an advanced page | Today it never shows streaming, sessions or approvals |
| G2 | Guides stop opening with `AgentExecutor`: `durable-execution.md`, `workspace-tools.md`, then the other 12 guides that import it; `testing.md` uses `defineTool()` | Executor examples move under an "Advanced: the executor API" heading |
| G3 | New page: Build a coding agent (the 27-line reference agent, explained) | Workspace tools + approvals + `streamResolve()` + a session |
| G4 | New pages: MCP (client and server, out of `configuration.md`), Hooks, Triggers | Each has a subpath and no page |
| G5 | New pages: Migrating from `AgentBuilder` / `AgentExecutor` to `createAgent()`; Troubleshooting | |
| G6 | New page: Cloudflare Workers, with the provider and tool limits stated up front | |
| G7 | Split the long pages: `api-overview.md` (873 lines), `errors.md`, `configuration.md`, `streaming.md` | Keep anchors working through redirects in the docs site |
| G8 | Stale statements: `providers.md` (reasoning, files), `installation.md` (optional peers table, MCP row, `tsup`), ticket ids out of user-facing text, the CHANGELOG header | |
| G9 | Docs site: Arabic translations kept current; a landing page section "Lousho vs eve vs AI SDK agents" with the honest matrix | |

## Wave 2: make the matrix true

| Id | Ticket | Notes |
|---|---|---|
| M1 | Send file parts (PDF and documents) through the built-in providers on `ai` 6 and 7; keep the text-note fallback on `ai` 4 | Row "Multimodal input" |
| M2 | `provider: fromAiSdk(model)`: accept any AI SDK `LanguageModel` (Google, Bedrock, Azure, Mistral, Gateway) | Row "Multi-provider"; export the adapter that already exists internally |
| M3 | Worker target: agent directories and TypeScript tools, not only spec files; OpenRouter provider; the `http` tool | Row "Edge runtime" |
| M4 | Background sub-agents that need approval pause the lead and can be resumed | Row "Background sub-agents" |
| M5 | `lousho traces`: a local trace viewer over a file or SQLite span exporter, and a Traces tab in Agent Forge | The one feature-level gap left from round 1 |
| M6 | A Linux CI job with a real Docker daemon for `SubprocessSandbox`, egress and the credential broker; fix what it finds | Rows "Sandboxing", "Credential brokering" |
| M7 | Registry: enforce the permission manifest at install; publish a static registry (tools, skills, channels) that `lousho add` uses by default | Row "Registry"; hosting is an **Owner** decision (lousho.com or GitHub Pages) |
| M8 | CI matrix with the real `ai` 6 package and with zod 4; Ollama on `ai` 6/7 | Today `ai` 6 is a stand-in |
| M9 | `send()` with a listener streams text in chunks like `stream()` | Open decision from round 1; changed Agent Forge results when tried, so it needs the Forge tests updated |
| M10 | Known limits from round 1: a pending `ask_question` in Slack or Discord survives a restart; remote sub-agent usage is added to the lead's totals; nested fingerprints are compared on resume | |

## Wave 3: new capability (the field and eve)

| Id | Ticket | Notes |
|---|---|---|
| N1 | Hosted provider tools: `webSearch()`, `codeInterpreter()`, `fileSearch()` passed through to OpenAI and Anthropic, with events and usage | Depends on M2's adapter |
| N2 | Tool search: `deferLoading` on tools and MCP servers, plus a `tool_search` tool; a threshold by share of the context window | Three vendors and eve converged on this |
| N3 | `session.fork({ fromStep })` and `session.history()` on `createAgent()` sessions; fork from a step in Agent Forge | `AgentExecutor.fork()` exists; this surfaces it |
| N4 | Permission modes: `plan`, `acceptEdits`, `dontAsk`, switchable mid-session; a plan-mode example | Named presets over the existing policies |
| N5 | Guardrail starter set: prompt-injection, PII, secret and moderation checks with a typed tripwire result; parallel or blocking | |
| N6 | Handoffs: `handoffs: [agent]` transfers the conversation, with an input filter | Distinct from sub-agents as tools |
| N7 | Workspace rewind: snapshot files before `write_file` / `edit_file`, `workspace.rewind(toTurn, { dryRun })` | |
| N8 | `openApiTools(document, { include, approval })`: an OpenAPI document becomes tools | |
| N9 | OAuth for tools and MCP servers: a pending sign-in pauses the run like an approval; token store on the `AgentStore` | Largest ticket of the wave; split into store, pause, and one provider |
| N10 | Route auth for `createRouteHandler()` and the built server: `jwt()`, `oidc()`, `basic()`, an ordered list; a principal on the run context, usable in tools, approvals and memory scope | |
| N11 | Channels: Telegram, GitHub (issue and pull-request comments), Microsoft Teams | One ticket each |
| N12 | `useTodos()` for React, Vue and Svelte over the existing todo tools; a todo event in the stream | |
| N13 | `web_fetch` built-in with SSRF checks and a redirect cap; streaming partial tool results (`async function*` execute) | |
| N14 | Code mode: one sandboxed script that calls several tools | After M6, since it runs in the sandbox |
| N15 | Semantic recall for memory: an embedding provider interface and a SQLite vector store | |

## Wave 4: API diet before 1.0 (breaking)

| Id | Ticket | Notes |
|---|---|---|
| A1 | Move out of the root, to subpaths: flows (`./flows` exists), Jira / GitHub / Slack / email tools (`./integrations`), `EncryptionUtils` and `StorageService` (`./utils`), validators | **Breaking.** 705 root exports today; docs use 123. Target under 300 |
| A2 | Remove: `AgentType` and its registry (already deprecated), repository interfaces, `ExecutionEvent` / `onEvent` legacy adapter, delegation tool (superseded by `subagents`) | **Breaking** |
| A3 | `AgentBuilder`, `AgentExecutor`, `ToolRegistry`, `resumeAfterApproval` move to `@lousho/build-ai-agent/executor`; the root keeps `createAgent()` and what it needs | **Breaking.** After G2, so no guide depends on the root import |
| A4 | Triggers versus channels and schedules: keep one way to do Slack and one way to do cron; deprecate the other | |
| A5 | Rename the patch guardrails (`runGuardrails`) so "guardrails" means input/output guardrails only | **Breaking** |
| A6 | Type-check the test files in CI (158 errors when round 1 ended); `skipLibCheck: false` consumers get clean types | |
| A7 | 1.0.0 release candidate: freeze the surface, API report (`api-extractor`) checked in CI, upgrade guide | **Owner** decides the date |

## Suggested order and size

51 tickets. Waves 0 and 1 (15 tickets) are mostly documentation and can run five at a time without touching the run loop. Wave 2 has two hub tickets (M4, M9) that must run alone. Wave 3's N1, N2 and N9 touch the provider and tool layers and should be sequenced, not parallel. Wave 4 is last because every ticket in it breaks imports.

What would move the scorecard: wave 0 flips "Published on npm" and "CLI scaffolding" (with the owner's publish) and "Durable stores"; wave 2 flips the other seven strict-rule ⚠️ rows and the trace viewer; wave 3 covers the 14 new rows.

## Live testing and budget

Audit 2 could not call a real model. For round 2 the owner provided an OpenRouter key with a hard limit of **10 USD for the whole round** (the limit is set on the key; usage was 0.00 on 2026-10-02). The key is **not in this repository**, which is public: it is in `E:agent-sdk.claudeound2.env` (git-ignored) as `OPENROUTER_API_KEY`, and the owner removes it after each phase. The rules for using it are in [BRIEF-2.md](BRIEF-2.md), "Tests and live calls": offline by default, live calls only where a ticket has a "Live test" section, cheapest model, spend measured with the key's own counter and reported in the pull request, cassettes recorded so CI replays for free.

| Phase | Tickets with live tests | Budget (USD) |
|---|---|---|
| Wave 0 | R1 (registry smoke test: one real turn) | 0.25 |
| Wave 1 | G1, G3 (run the new quick start and coding-agent page once against a real model) | 0.50 |
| Wave 2 | M1 (file input), M2 (other providers through OpenRouter), M5, M8, M9, M10 | 3.00 |
| Wave 3 | N1, N2, N4, N5, N6, N13, N14, N15 and one live pass per channel or auth ticket where possible | 4.50 |
| Wave 4 | A7 (release-candidate smoke run) | 0.50 |
| Reserve | re-runs after review, flaky provider responses | 1.25 |

A ticket without a line here spends nothing. Default cap per ticket: 0.10 USD unless its issue says otherwise.

Docker: no daemon runs on the owner's machine, and the egress features are refused on Docker Desktop by design. Real-daemon coverage comes from the Linux CI job in M6.

## Tickets

Each ticket is a GitHub issue in LinuxDevil/agent-sdk labelled `round-2`, with a wave label, `model:sonnet` or `model:opus`, and where it applies `hub`, `breaking`, `owner-decision` or `live-test`. Every issue is self-contained: goal, evidence with file paths, scope, acceptance criteria, verification, live-test budget, dependencies. An agent needs only the issue and [BRIEF-2.md](BRIEF-2.md).

## Owner decisions needed before starting

1. Start round 2 at all, and which waves.
2. R4: drop `src/` and source maps from the tarball?
3. M7: where the default registry is hosted.
4. Wave 4: whether pre-1.0 breaking moves are acceptable now that the package is public.
5. Docs domain: decided, https://lousho.com.
6. Rename the GitHub repositories to `lousho` and `lousho-docs`.
