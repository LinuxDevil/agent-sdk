# Round 2 tickets

Filed 2026-10-02 as GitHub issues in LinuxDevil/agent-sdk, label `round-2`. 71 tickets. Rules for working one: [BRIEF-2.md](BRIEF-2.md). The plan: [PLAN-2.md](PLAN-2.md).

| Id | Issue | Title | Labels |
|---|---|---|---|
| R1a | [#187](https://github.com/LinuxDevil/agent-sdk/issues/187) | Fix lousho studio outside the SDK repo: use the installed Agent Forge | wave-0, model:sonnet |
| R1b | [#188](https://github.com/LinuxDevil/agent-sdk/issues/188) | Add registry-smoke: test the published packages from the npm registry | wave-0, model:sonnet, live-test |
| R2 | [#189](https://github.com/LinuxDevil/agent-sdk/issues/189) | Export KVStore from a /kv subpath and add fileStore(dir) | wave-0, model:opus |
| R3 | [#190](https://github.com/LinuxDevil/agent-sdk/issues/190) | Build lock in tests: detect a dead owner by PID, not by age | wave-0, model:sonnet |
| R4 | [#191](https://github.com/LinuxDevil/agent-sdk/issues/191) | Slim the npm tarball: drop test files and source map weight, fix pack-smoke | wave-0, model:sonnet, owner-decision |
| R5 | [#192](https://github.com/LinuxDevil/agent-sdk/issues/192) | Docs site: a workflow that syncs the SDK docs and opens a pull request | wave-0, model:sonnet |
| G1 | [#193](https://github.com/LinuxDevil/agent-sdk/issues/193) | Rewrite the quick start around createAgent(); move the executor to its own page | wave-1, model:sonnet, live-test |
| G2a | [#194](https://github.com/LinuxDevil/agent-sdk/issues/194) | durable-execution and workspace-tools lead with createAgent(), not AgentExecutor | wave-1, model:sonnet |
| G2b | [#195](https://github.com/LinuxDevil/agent-sdk/issues/195) | approvals, sessions, streaming, sub-agents, compaction, skills: executor examples to Advanced | wave-1, model:sonnet |
| G2c | [#196](https://github.com/LinuxDevil/agent-sdk/issues/196) | Guides stop teaching the executor and the legacy tool record (7 pages) | wave-1, model:sonnet |
| G3 | [#197](https://github.com/LinuxDevil/agent-sdk/issues/197) | New guide: build a coding agent (workspace tools, approvals, streaming, a session) | wave-1, model:sonnet, live-test |
| G4a | [#198](https://github.com/LinuxDevil/agent-sdk/issues/198) | New page: MCP client and server, moved out of configuration.md | wave-1, model:sonnet |
| G4b | [#199](https://github.com/LinuxDevil/agent-sdk/issues/199) | New page: Hooks (pre/post tool call and model call), out of api-overview.md | wave-1, model:sonnet |
| G4c | [#200](https://github.com/LinuxDevil/agent-sdk/issues/200) | New page: Triggers (webhook, Slack, cron adapters), out of api-overview.md | wave-1, model:sonnet |
| G5a | [#201](https://github.com/LinuxDevil/agent-sdk/issues/201) | New page: migrating from AgentBuilder / AgentExecutor to createAgent() | wave-1, model:sonnet |
| G5b | [#202](https://github.com/LinuxDevil/agent-sdk/issues/202) | New page: Troubleshooting and FAQ | wave-1, model:sonnet |
| G6 | [#203](https://github.com/LinuxDevil/agent-sdk/issues/203) | New page: Cloudflare Workers, with the limits stated first | wave-1, model:sonnet |
| G7 | [#204](https://github.com/LinuxDevil/agent-sdk/issues/204) | Split the long pages: api-overview, streaming and configuration (errors stays whole) | wave-1, model:sonnet |
| G8 | [#205](https://github.com/LinuxDevil/agent-sdk/issues/205) | Remaining stale statements: ticket ids in Agent Forge, AgentType, undici, one source comment | wave-1, model:sonnet |
| G9a | [#206](https://github.com/LinuxDevil/agent-sdk/issues/206) | Docs site: sync wave-1 pages, navigation, pending-translation check, comparison section | wave-1, model:sonnet, owner-decision |
| G9b | [#207](https://github.com/LinuxDevil/agent-sdk/issues/207) | Docs site: Arabic translations, guides rewritten around createAgent() (part 1) | wave-1, model:sonnet |
| G9c | [#208](https://github.com/LinuxDevil/agent-sdk/issues/208) | Docs site: Arabic translations, reference and operations pages (part 2) | wave-1, model:sonnet |
| G9d | [#209](https://github.com/LinuxDevil/agent-sdk/issues/209) | Docs site: Arabic translations, twelve new pages and the Arabic navigation (part 3) | wave-1, model:sonnet |
| N1a | [#211](https://github.com/LinuxDevil/agent-sdk/issues/211) | Hosted provider tools: webSearch(), codeInterpreter(), fileSearch() on OpenAI | wave-3, model:opus, hub |
| N1b | [#212](https://github.com/LinuxDevil/agent-sdk/issues/212) | Hosted tools on Anthropic and OpenRouter, with a live web search test | wave-3, model:sonnet, live-test |
| N2 | [#213](https://github.com/LinuxDevil/agent-sdk/issues/213) | Tool search: deferLoading on tools and MCP servers, and a tool_search tool | wave-3, model:opus, hub, live-test |
| N3a | [#214](https://github.com/LinuxDevil/agent-sdk/issues/214) | Add session.history() and session.fork({ fromStep }) to agent sessions | wave-3, model:opus |
| N4 | [#215](https://github.com/LinuxDevil/agent-sdk/issues/215) | Permission modes: plan, acceptEdits and dontAsk, switchable mid-session | wave-3, model:opus, live-test |
| N5a | [#216](https://github.com/LinuxDevil/agent-sdk/issues/216) | Guardrail starter set: PII, secrets, prompt injection, moderation | wave-3, model:opus, live-test |
| N5b | [#217](https://github.com/LinuxDevil/agent-sdk/issues/217) | Run input guardrails in parallel with the first model call | wave-3, model:opus, hub, live-test |
| N6 | [#218](https://github.com/LinuxDevil/agent-sdk/issues/218) | Handoffs: transfer the conversation to another agent | wave-3, model:opus, hub, live-test |
| N7 | [#219](https://github.com/LinuxDevil/agent-sdk/issues/219) | Workspace rewind: snapshot files before write_file / edit_file, rewind by turn | wave-3, model:opus |
| N8 | [#220](https://github.com/LinuxDevil/agent-sdk/issues/220) | openApiTools(document, { include, approval }): an OpenAPI document becomes tools | wave-3, model:sonnet |
| M1 | [#221](https://github.com/LinuxDevil/agent-sdk/issues/221) | Send PDF file parts through the built-in providers on ai 6 and 7 | wave-2, model:sonnet, live-test |
| M2 | [#222](https://github.com/LinuxDevil/agent-sdk/issues/222) | fromAiSdk(model): use any AI SDK LanguageModel as the provider | wave-2, model:opus, live-test |
| M3a | [#223](https://github.com/LinuxDevil/agent-sdk/issues/223) | Cloudflare Worker target: OpenRouter provider and an allowlisted http tool | wave-2, model:opus |
| M3b | [#224](https://github.com/LinuxDevil/agent-sdk/issues/224) | Cloudflare Worker target: build an agent directory with TypeScript tools | wave-2, model:opus |
| M4 | [#225](https://github.com/LinuxDevil/agent-sdk/issues/225) | Background sub-agents that need approval pause the lead and resume | wave-2, model:opus, hub |
| M5a | [#226](https://github.com/LinuxDevil/agent-sdk/issues/226) | lousho traces: file trace exporter, createAgent exporter, terminal viewer | wave-2, model:opus, live-test |
| M5b | [#227](https://github.com/LinuxDevil/agent-sdk/issues/227) | Agent Forge: persisted trace history in the Trace tab | wave-2, model:sonnet |
| M6 | [#228](https://github.com/LinuxDevil/agent-sdk/issues/228) | Linux Docker CI job: real-daemon tests for sandbox egress and credential broker | wave-2, model:opus |
| M7a | [#229](https://github.com/LinuxDevil/agent-sdk/issues/229) | lousho add: enforce the permission manifest at install | wave-2, model:opus |
| M7b | [#230](https://github.com/LinuxDevil/agent-sdk/issues/230) | Default static registry that lousho add uses out of the box | wave-2, model:sonnet, owner-decision |
| M8 | [#231](https://github.com/LinuxDevil/agent-sdk/issues/231) | CI peer matrix: real ai 6, ai 6/7 with zod 4, and Ollama on ai 6/7 | wave-2, model:sonnet, live-test |
| M9 | [#232](https://github.com/LinuxDevil/agent-sdk/issues/232) | send() and execute() with a listener stream model calls like stream() | wave-2, model:opus, hub, breaking, live-test |
| M10a | [#233](https://github.com/LinuxDevil/agent-sdk/issues/233) | Slack and Discord: a pending ask_question survives a restart | wave-2, model:opus |
| M10b | [#234](https://github.com/LinuxDevil/agent-sdk/issues/234) | Add remote sub-agent token usage to the lead's totals | wave-2, model:opus, live-test |
| M10c | [#235](https://github.com/LinuxDevil/agent-sdk/issues/235) | Compare a paused sub-agent's fingerprint fully on resume | wave-2, model:opus |
| A1 | [#236](https://github.com/LinuxDevil/agent-sdk/issues/236) | Move flows, integrations and utilities out of the package root into subpaths | wave-4, model:sonnet, breaking, owner-decision |
| A2a | [#237](https://github.com/LinuxDevil/agent-sdk/issues/237) | Remove AgentType, its registry, repository interfaces and unused donor types | wave-4, model:sonnet, breaking, owner-decision |
| A2b | [#238](https://github.com/LinuxDevil/agent-sdk/issues/238) | Remove the deprecated ExecuteOptions.onEvent and ExecutionEvent adapter | wave-4, model:opus, hub, breaking, owner-decision |
| A2c | [#239](https://github.com/LinuxDevil/agent-sdk/issues/239) | Remove createDelegateTool in favor of the subagents option | wave-4, model:opus, breaking, owner-decision |
| A3 | [#240](https://github.com/LinuxDevil/agent-sdk/issues/240) | Move AgentBuilder, AgentExecutor and resumeAfterApproval to ./executor | wave-4, model:opus, breaking, owner-decision |
| A4 | [#241](https://github.com/LinuxDevil/agent-sdk/issues/241) | Deprecate the Slack, cron and webhook trigger adapters | wave-4, model:sonnet |
| A5 | [#242](https://github.com/LinuxDevil/agent-sdk/issues/242) | Rename the patch guardrails to patch checks (runPatchChecks) | wave-4, model:sonnet, breaking, owner-decision |
| A6a | [#243](https://github.com/LinuxDevil/agent-sdk/issues/243) | Type-check test files: add tsconfig.tests.json, fix the run-loop tests | wave-4, model:sonnet |
| A6b | [#244](https://github.com/LinuxDevil/agent-sdk/issues/244) | Type-check test files in CI and check published types with skipLibCheck off | wave-4, model:sonnet |
| A7 | [#245](https://github.com/LinuxDevil/agent-sdk/issues/245) | Prepare the 1.0.0 release candidate: API report in CI, upgrade guide, version | wave-4, model:opus, owner-decision, live-test |
| N9a | [#246](https://github.com/LinuxDevil/agent-sdk/issues/246) | OAuth token store on the AgentStore, encrypted, with credential owners | wave-3, model:opus |
| N9b | [#247](https://github.com/LinuxDevil/agent-sdk/issues/247) | OAuth sign-in for tools: ctx.getToken() pauses the run until sign-in | wave-3, model:opus, hub, live-test |
| N9c | [#248](https://github.com/LinuxDevil/agent-sdk/issues/248) | OAuth for HTTP MCP servers per the MCP authorization spec | wave-3, model:opus |
| N10a | [#249](https://github.com/LinuxDevil/agent-sdk/issues/249) | Route auth: jwt(), oidc(), basic() in an ordered list, principal per run | wave-3, model:opus |
| N10b | [#250](https://github.com/LinuxDevil/agent-sdk/issues/250) | Principal in tools, approval policies and permissions, kept on pause | wave-3, model:opus, hub |
| N11a | [#251](https://github.com/LinuxDevil/agent-sdk/issues/251) | Add telegramChannel(): Telegram bot webhooks, inline-keyboard approvals | wave-3, model:sonnet, live-test |
| N11b | [#252](https://github.com/LinuxDevil/agent-sdk/issues/252) | Add githubChannel(): the agent answers issue and pull-request comments | wave-3, model:sonnet, live-test |
| N11c | [#253](https://github.com/LinuxDevil/agent-sdk/issues/253) | Add teamsChannel(): Microsoft Teams bots with Adaptive Card approvals | wave-3, model:sonnet, live-test |
| N12 | [#254](https://github.com/LinuxDevil/agent-sdk/issues/254) | todo.updated stream event and useTodos() for React, Vue and Svelte | wave-3, model:sonnet |
| N13a | [#255](https://github.com/LinuxDevil/agent-sdk/issues/255) | Add a web_fetch built-in with pinned-DNS SSRF checks and a redirect cap | wave-3, model:opus, live-test |
| N13b | [#256](https://github.com/LinuxDevil/agent-sdk/issues/256) | Stream partial tool results: async generator execute, tool.partial event | wave-3, model:opus, hub, live-test |
| N14 | [#257](https://github.com/LinuxDevil/agent-sdk/issues/257) | Code mode: a run_code tool where one sandboxed script calls several tools | wave-3, model:opus, hub, live-test |
| N15 | [#258](https://github.com/LinuxDevil/agent-sdk/issues/258) | Semantic recall: an embedding provider and a SQLite vector memory | wave-3, model:sonnet, live-test |
