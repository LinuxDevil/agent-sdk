# open-harness re-audit and field scan

Date 2026-10-02. Read-only. Previous audit: `E:\agent-sdk\.claude\worktrees\loop-orch\.agent-loop\AUDIT.md` (open-harness at `026e8d9`, `@openharness/core` 0.7.0).

Labels: **[V]** verified (file path in the clone, command output, or a URL whose content I read), **[I]** inferred. Paths without a prefix are relative to the clone at `scratchpad/audit2/open-harness`. Downloaded doc sources used for Part B are in `scratchpad/audit2/field/`.

---

# Part A: open-harness

## A1. Version and commit

| Item | Value | Status |
|---|---|---|
| HEAD of `main` | `026e8d9cb8f184cdeac2054b489ec20972ba8681`, 2026-07-17 21:21:15 +0700, "Add package status badges to README" | [V] `git log -1`, `git ls-remote origin` (HEAD and `refs/heads/main` both `026e8d9`) |
| Same commit as the old audit? | **Yes, identical.** No commit has landed on `main` in 11 weeks | [V] |
| GitHub `pushed_at` | 2026-07-17T14:21:37Z; 616 stars; not archived; only branch is `main` | [V] `gh api repos/MaxGfeller/open-harness` |
| `@openharness/core` | 0.7.0, published 2026-06-15 (latest; no newer version) | [V] `npm view @openharness/core version time` |
| `@openharness/react` | 2.0.1, 2026-06-18; peers `@ai-sdk/react ^3`, `@openharness/core ^0.7.0` | [V] `npm view` |
| `@openharness/vue` | 2.0.1, 2026-06-18; peers `@ai-sdk/vue ^3`, `vue ^3.3.4` | [V] |
| `@openharness/provider-vfs` | 0.1.4, 2026-06-15; peer `@platformatic/vfs >=0.3.0` | [V] |
| `@openharness/provider-chatgpt` | 0.1.2, 2026-07-03 | [V] |
| Other packages in scope | None. `@openharness/cli`, `/svelte`, `/server` return E404. `npm search @openharness` returns only the five above under that scope (other hits are unrelated projects: `@goondan/openharness-*`, `@zhijiewang/openharness`, etc.) | [V] |
| Core dependencies | `ai ^6.0.97`, `@ai-sdk/mcp ^1.0.21`, `zod ^4.3.6` | [V] `packages/core/package.json` |
| `ai` on npm today | `latest` 7.0.127, `ai-v6` 6.0.300 | [V] `npm view ai dist-tags` |

## A2. Changes since `026e8d9`

**None in the repository or on npm.** [V]

- `git log` HEAD is the audited commit; the newest tags are `@openharness/provider-chatgpt@0.1.2` and `@openharness/react@2.0.1`, both older than the audited commit.
- `packages/core/CHANGELOG.md` top entry is still 0.7.0 (todo tools).
- Docs under `apps/docs` are unchanged (18 `.mdx` pages); the live `https://docs.open-harness.dev/llms-full.txt` lists the same 18 sources. [V] (curl 200, 74,733 bytes; this was blocked in the previous audit and is reachable now)
- Unmerged activity only: PR #6 "feat(core): forward streamText onError callback" (open since 2026-07-18); PR #7 "feat(core): agent tool loop options" (closed 2026-07-21, not on `main`). [V] `gh api .../issues?state=all`

Three things shipped in the month *before* the audited commit and are not rows in the old matrix (they are in A4): todo tools (core 0.7.0, 2026-06-15), resumable UI streams (react/vue 2.0.1, commit `2b404ad`, 2026-06-18), and the ChatGPT OAuth provider fix (0.1.2, 2026-07-03).

## A3. Matrix re-verification (all 51 rows)

"Changed?" compares against the old audit's open-harness cell. Because HEAD is identical, every "no" is a re-confirmation, and the two flagged rows are corrections to the old audit, not changes in open-harness.

| # | Capability | open-harness now | Evidence | Changed? |
|---|---|---|---|---|
| 1 | Durability / resume | ⚠️ transcript saved only at turn end; retry restores a snapshot; no step checkpoints | `packages/core/src/session.ts:468-471` ("Persist"), `middleware/persistence.ts:15-22` | no |
| 2 | Durable stores (SQLite/file/KV) | ❌ `SessionStore` interface only; shipped stores are in-memory (`InMemoryTodoStore`, `InMemorySubagentSessionMetadataStore`). The SQLite in `provider-vfs` backs the agent's *filesystem*, not sessions | `session.ts:55-59`, `todos.ts`, `subagents.ts:40-64`, `apps/docs/core/providers.mdx` "Storage Backends" | no |
| 3 | Sandboxing | ⚠️ `FsProvider`/`ShellProvider` interfaces + `VfsFsProvider` (fs only). No sandboxed shell; `NodeShellProvider` runs `bash -c` with `process.env` merged. E2B/Docker/Daytona are listed as "possible targets" only | `providers/types.ts`, `providers/node.ts:121-131`, `apps/docs/core/providers.mdx` "Custom Providers" | no |
| 4 | Workspace fs + shell tools | ✅ `readFile`, `writeFile`, `editFile`, `listFiles`, `grep`, `deleteFile`, `bash` | `tools/create-fs-tools.ts`, `tools/create-bash-tool.ts`, `apps/docs/tools/built-in-tools.mdx` | no |
| 5 | Compaction | ✅ prune then summarize, `DefaultCompactionStrategy`, `withCompaction`, manual `session.compact()` | `session.ts:152-224, 478-521`, `middleware/compaction.ts` | no |
| 6 | Subagents | ✅ `task` tool, nesting via `maxSubagentDepth` | `agent.ts:473-675`, `apps/docs/advanced/subagents.mdx` | no |
| 7 | Background / resumable subagents | ✅ `subagentBackground` + `agent_status/agent_cancel/agent_await` (modes all/allSettled/any/race); session modes stateless/new/resume/fork | `agent-registry.ts`, `agent.ts:114, 677-789, 791-944` | no |
| 8 | Remote subagents | ❌ subagents are in-process `Agent` instances | `agent.ts:515-545`; grep `remote` in core: none | no |
| 9 | Approvals / HITL | ⚠️ one in-process `approve()` callback returning boolean; not durable; subagents never prompt | `agent.ts:83-85, 1115-1140`, `apps/docs/tools/permissions.mdx` (Note) | no |
| 10 | Agent asks the user a question | ❌ | grep `askUser\|ask_user\|question` hits only the docs' illustrative `askUser()` in `permissions.mdx` and `examples/cli/cli.ts` | no |
| 11 | Steering (mid-run input) | ❌ abort only | grep `steer\|interrupt\|queue` in `packages/core/src`: only `controller.enqueue` in `ui-stream.ts` | no |
| 12 | Cancellation | ✅ `signal` on `run()`/`send()`; aborted run yields `done: "stopped"` with partial messages | `agent.ts:250-254, 426-451` | no |
| 13 | Memory (cross-session) | ❌ | grep `memory` hits only in-memory stores and subagent "memory" wording | no |
| 14 | Sessions (multi-turn) | ✅ `Session`, plus the lighter `Conversation` | `session.ts:296-567`, `conversation.ts` | no |
| 15 | Skills (SKILL.md) | ✅ | `skills.ts`, `tools/skill.ts`, `apps/docs/advanced/skills.mdx` | no |
| 16 | AGENTS.md loading | ✅ default on; falls back to `CLAUDE.md`; walks up to fs root | `instructions.ts:4-30`, `agent.ts:214` | no |
| 17 | Evals | ❌ | grep `eval\|scorer` in docs and src: none | no |
| 18 | Eval against deployed URL | ❌ | same grep | no |
| 19 | Test utils (mock model, record/replay) | ❌ | grep `mockmodel\|MockLanguageModel\|record.?replay` in non-test src and docs: none | no |
| 20 | Tracing / OTel GenAI | ❌ | grep `telemetry\|opentelemetry\|otel\|tracing`: none | no |
| 21 | Metrics / trace viewer | ❌ | same grep | no |
| 22 | Multi-provider | ✅ any AI SDK `LanguageModel` | `agent.ts:160`, `apps/docs/getting-started/installation.mdx` | no |
| 23 | Fallbacks / retry policy | ⚠️ retry with backoff only, and only before content is streamed; no model fallback | `middleware/retry.ts`, `session.ts:390-457` | no |
| 24 | Structured output | ❌ `Agent` has no output-schema option; `streamText` is called without `output` | `agent.ts:156-206, 302-311` | no |
| 25 | Multimodal input | ✅ `run(history, input: string \| ModelMessage[])`; `extractUserInput()` converts UI file parts to `FilePart` | `agent.ts:250-260`, `messages.ts:11-55` | no (extra evidence found) |
| 26 | Reasoning control / events | ⚠️ `reasoning.delta/done` events; no `providerOptions` pass-through on `Agent` | `agent.ts:56-57, 302-311`, `apps/docs/core/agents.mdx:70-71` | no |
| 27 | MCP client | ✅ `mcpServers` stdio/http/sse, lazy connect, namespacing, `agent.close()` | `mcp.ts`, `agent.ts:266-268` | no |
| 28 | MCP server | ❌ | no server code in `packages/*/src` | no |
| 29 | Typed event stream | ✅ `AgentEvent` + `SessionLifecycleEvent` unions | `agent.ts:53-69`, `session.ts:19-28` | no |
| 30 | UI bindings React/Vue/Svelte | ⚠️ React and Vue; `@openharness/svelte` is E404 | `packages/react/src/index.ts`, `packages/vue/src/index.ts`, npm | no |
| 31 | AI SDK UI stream | ✅ `toUIMessageStream()` / `toResponse()` + `data-oh:*` parts | `ui-stream.ts`, `session.ts:528-548`, `apps/docs/ui-integration/server-streaming.mdx` | no |
| 32 | CLI scaffolding | ❌ "OpenHarness does not provide a CLI" | `packages/provider-chatgpt/README.md` ("Browser Callback Login") | no |
| 33 | Dev TUI / REPL | ⚠️ example readline CLI only, run from a repo clone | `examples/cli/cli.ts` (424 lines), `apps/docs/examples.mdx` | no |
| 34 | Visual studio / debugger | ❌ | `apps/` holds only `docs` and the marketing `web` site | no |
| 35 | Channels | ❌ | grep `slack\|discord\|telegram\|webhook`: none | no |
| 36 | Schedules | ❌ | grep `cron\|schedule`: none | no |
| 37 | Deploy story | ❌ bring your own route with `toResponse()` | `apps/docs/ui-integration/server-streaming.mdx` "Next.js Example" | no |
| 38 | Edge runtime (Workers) | ❌ core's entry imports `node:fs`/`node:path`; Workers named only as a possible custom-provider target | `instructions.ts:1-2`, `providers/node.ts`, `apps/docs/core/providers.mdx` | no |
| 39 | Budgets / limits | ⚠️ `maxSteps` (default 100) reported as `done.result: "max_steps"`; `maxTokens` per call; no cost or session-token budget | `agent.ts:211, 403-411` | no |
| 40 | Guardrails (input/output) | ❌ | grep `guardrail`: none. `onBeforeSend` can rewrite messages but is a hook, not a guardrail (`session.ts:80-91`) | no |
| 41 | Permissions policy | ⚠️ one global `approve()` callback | `apps/docs/tools/permissions.mdx` | no |
| 42 | Credential brokering | ❌ shell inherits host env. `provider-chatgpt` stores OAuth tokens for *model* auth, which is not brokering | `providers/node.ts:131`, `packages/provider-chatgpt/src/token-store.ts` | no |
| 43 | Dynamic config | ⚠️ dynamic `SubagentCatalog` (`list()`/`resolve()`) only | `subagents.ts:9-14` | no |
| 44 | Hot reload | ❌ | grep `hot.?reload\|watch`: only Vue `watch` | no |
| 45 | Registry / extensions | ❌ | grep `registry`: only `AgentRegistry` (background runs) | no |
| 46 | ACP | ❌ | grep `\bacp\b`: none | no |
| 47 | Code-first authoring | ✅ | `README.md` Quick Start | no |
| 48 | Directory authoring | ❌ (skills directory discovery only) | `skills.ts` | no |
| 49 | Agent-readable docs | ✅ `llms.txt` (2,399 bytes) and `llms-full.txt` (74,733 bytes), both HTTP 200 | `https://docs.open-harness.dev/llms.txt`, `.../llms-full.txt` | no (now verified directly; old audit could not fetch it) |
| 50 | Published on npm | ✅ 0.7.0 | `npm view @openharness/core version` | no |
| 51 | Current `ai` major | **⚠️ one major behind**: depends on `ai ^6.0.97`; npm `latest` is 7.0.127 | `packages/core/package.json`, `npm view ai dist-tags` | **FLAG (correction).** Old cell said "✅ v6", but the old audit's own npm facts already listed `ai` 7.0.126 as latest. open-harness did not change; the old cell was generous |

Flagged cells: **row 51 only** (correction). Rows 25 and 49 keep their value with stronger evidence. No cell changed because of new open-harness work, since there is none.

## A4. Capabilities not in the old matrix

All [V] at the paths given.

1. **Todo tools**: session-scoped `todowrite`/`todoread`, pluggable `TodoStore`, `oh:todo.updated` stream part. `packages/core/src/tools/create-todo-tools.ts`, `todos.ts`
2. **Todo UI state hooks**: `useTodos` for React and Vue. `packages/react/src/hooks/use-todos.ts`, `packages/vue/src/composables/useTodos.ts`
3. **Resumable UI streams (client side)**: `resume: true` + `prepareReconnectToStreamRequest`, default `GET ${endpoint}/${id}/stream`. The server-owned run is described as a contract but not implemented in core. `apps/docs/ui-integration/react.mdx` "Resuming Streams", `server-streaming.mdx` "Resumable Streams", `packages/react/src/transport.ts`
4. **Middleware / Runner composition**: `toRunner`, `pipe`, `apply`, `withRetry`, `withCompaction`, `withTurnTracking`, `withPersistence`, `withHooks`. `packages/core/src/runner.ts`, `middleware/`
5. **Stream combinators**: `tap`, `filter`, `map`, `takeUntil`. `packages/core/src/stream.ts`
6. **`Conversation`**: thin stateful wrapper over a composed runner. `packages/core/src/conversation.ts`
7. **ChatGPT/Codex subscription OAuth model provider** (browser callback, device flow, token stores). `packages/provider-chatgpt/`
8. **Virtual filesystem provider** (memory, SQLite-backed, or real-FS-scoped). `packages/provider-vfs/src/vfs-provider.ts`
9. **Subagent session fork** (clone a subagent transcript into a new session). `packages/core/src/agent.ts:848-870`
10. **Subagent await modes** all/allSettled/any/race. `packages/core/src/agent.ts:721-789`
11. **Live subagent events with ancestry path** (`onSubagentEvent(path, event)`). `packages/core/src/agent.ts:94-97`
12. **UI status hooks**: `useSubagentStatus`, `useSessionStatus`, `useSandboxStatus` (the last is a no-op unless the host emits `oh:sandbox.*`). `packages/react/src/index.ts`, `hooks/use-sandbox-status.ts`
13. **Pluggable compaction**: `CompactionStrategy` interface, `summaryModel`, `shouldCompact`, `onCompaction` prompt hook. `packages/core/src/session.ts:32-51, 124-127, 159-170`
14. **Session hooks**: `onBeforeSend` (rewrite history), `onAfterResponse`, `onError`. `packages/core/src/session.ts:80-91`
15. **Paginated `grep`/`listFiles`** within a byte budget (32 KB default). `packages/core/CHANGELOG.md` 0.6.1, `tools/create-fs-tools.ts`
16. **UI file-part decoding** (`extractUserInput` strips data URLs to base64). `packages/core/src/messages.ts`
17. **Typed custom data parts and guards** (`isSubagentEvent`, `isCompactionEvent`, ...). `packages/core/src/types/stream-parts.ts`

## A5. DX facts

Documented path, `apps/docs/getting-started/quickstart.mdx` [V]:

1. `mkdir my-agent && cd my-agent`
2. `npm init -y`
3. `npm install @openharness/core @ai-sdk/openai`
4. `export OPENAI_API_KEY=sk-...`
5. Write `agent.ts` (about 30 lines across the two snippets; model `openai("gpt-5.4")`).
6. Run it: **the docs give no run command.** No `tsx`, no `"type": "module"` step, although the snippet uses top-level `for await`. [V]

So: 4 documented commands, 1 file, plus 1 to 2 undocumented steps (`npm pkg set type=module`, `npx tsx agent.ts`), as the old audit also assumed.

Other facts:
- The quickstart imports `type ModelMessage` from `"ai"` without installing `ai` (works via npm hoisting; would fail under pnpm strict). [V] snippet; [I] failure mode
- **Likely version trap today [I]:** `npm install @ai-sdk/openai` now resolves to 4.0.83, which depends on `@ai-sdk/provider` 4.0.21, while core pulls `ai@6` on `@ai-sdk/provider` 3.0.18 ([V] `npm view`). Core's own devDependency is `@ai-sdk/openai ^3.0.30`. The docs do not pin `@3`. I did not install and run it, so the break itself is inferred.
- No scaffolder, no CLI, no REPL binary; the example CLI needs `git clone` + `pnpm install && pnpm build` + `pnpm --filter cli-demo start`. [V] `apps/docs/examples.mdx`

---

# Part B: wider field (ideas only)

Versions today [V] `npm view`: `@anthropic-ai/claude-agent-sdk` 0.3.287, `@openai/agents` 0.18.0, `@mastra/core` 1.74.0, `ai` 7.0.127, `@langchain/langgraph` 1.4.18, `@strands-agents/sdk` 1.19.0.

Items you already have are omitted. Each line is something a TS user would notice.

## B1. Claude Agent SDK (TypeScript)

1. **Permission modes**, including `plan`, `acceptEdits`, `dontAsk`, `auto` (model classifier), switchable mid-session with `setPermissionMode()`. [V] https://code.claude.com/docs/en/agent-sdk/permissions.md
2. **Session continue / resume / fork**, `resumeSessionAt` a message, plus `listSessions`, `renameSession`, `tagSession`. [V] https://code.claude.com/docs/en/agent-sdk/sessions.md ; option names from https://code.claude.com/docs/en/agent-sdk/typescript ([V] via summarised fetch)
3. **File checkpointing and rewind**: files backed up before Write/Edit; `rewindFiles(userMessageId, { dryRun })` restores disk state without rewinding the conversation. [V] https://code.claude.com/docs/en/agent-sdk/file-checkpointing.md
4. **Tool search on by default**: tool definitions withheld, up to five loaded on demand, `auto:N` threshold by share of context window. [V] https://code.claude.com/docs/en/agent-sdk/tool-search.md
5. **Plugins**: a local-path bundle of skills, agents, hooks and MCP servers, reloadable mid-session. [V] https://code.claude.com/docs/en/agent-sdk/plugins.md
6. **Image input** in streaming input mode (base64 image blocks). [V] https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.md
7. **Built-in web search tool** ("search the web" in the built-in tools row). [V] https://code.claude.com/docs/en/agent-sdk/overview
8. **Automatic prompt caching** with cache-token accounting and a one-hour TTL option; `maxBudgetUsd`; `fallbackModel` list. [V] https://code.claude.com/docs/en/agent-sdk/cost-tracking.md ; option names from the TypeScript reference
9. **Session store adapters with reference implementations** (S3, Redis, Postgres) and a "validate your adapter" conformance step. [V] https://code.claude.com/docs/en/agent-sdk/session-storage.md
10. **Mid-run control methods**: `interrupt()`, `setModel()`, `streamInput()`, `stopTask()`, `getContextUsage()`. [V] https://code.claude.com/docs/en/agent-sdk/typescript (summarised fetch; method list not re-read line by line)

## B2. OpenAI Agents SDK for JS (`@openai/agents`)

1. **Handoffs**: `handoffs` array or `handoff()` with `onHandoff`, `inputType`, `inputFilter`, `isEnabled`. [V] https://openai.github.io/openai-agents-js/guides/handoffs
2. **Hosted tools**: `webSearchTool`, `fileSearchTool`, `codeInterpreterTool`, `imageGenerationTool`; plus `computerTool`, `shellTool`, `applyPatchTool`. [V] https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/tools.mdx
3. **Tool search / deferred tools**: `toolSearchTool()` with `deferLoading: true`, `toolNamespace()` groups. [V] same file
4. **Programmatic Tool Calling**: the model writes JavaScript that coordinates several tool calls. [V] same file, "Programmatic Tool Calling"
5. **Guardrail tripwires**: input, output and per-tool guardrails; `tripwireTriggered` throws `InputGuardrailTripwireTriggered` / `OutputGuardrailTripwireTriggered`; `runInParallel: true` (default) versus blocking. [V] https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/guardrails.mdx
6. **Tracing on by default with a hosted viewer**: Trace, TaskSpan, AgentSpan, TurnSpan, GenerationSpan, FunctionSpan, GuardrailSpan, HandoffSpan; `addTraceProcessor()` / `setTraceProcessors()`. [V] https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/tracing.mdx
7. **Voice / realtime agents**: `RealtimeAgent`, `RealtimeSession`, WebRTC / WebSocket / SIP transports, Twilio and Cloudflare extensions. [V] https://openai.github.io/openai-agents-js/guides/voice-agents (class names via summarised fetch)
8. **Sandbox agents with hosted clients**: `SandboxAgent` capabilities `shell()`, `filesystem()`, `skills()`, `memory()`, `compaction()`; clients Unix-local, Docker, Blaxel, Cloudflare, Daytona, E2B, Modal, Runloop, Vercel; snapshots, mounts, exposed ports. [V] https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/sandbox-agents/clients.mdx and `concepts.mdx`
9. **Serialisable run state**: `result.state.toString()` and `RunState.fromString(agent, s)` to resume a paused approval in another process. [V] https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/human-in-the-loop.mdx (you already have durable approvals; the idea is the single portable string)
10. **Server-managed conversation state and server-side compaction** (`OpenAIConversationsSession`, `conversationId`, `previousResponseId`, Responses compaction at 90% of the window). [V] https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/sessions.mdx

## B3. Mastra

1. **Memory tiers**: working memory, semantic recall, and observational memory (Observer at 30k message tokens, Reflector at 40k observation tokens, prompt-prefix stays cacheable). [V] https://mastra.ai/docs/memory/observational-memory.md ; working memory and semantic recall URLs listed in https://mastra.ai/llms.txt ([V] URL listed, body not read)
2. **Studio**: local UI at `localhost:4111` from `mastra dev` with agent chat, workflow graph, traces, scorers, datasets and experiments, MCP explorer. [V] https://mastra.ai/docs/studio/overview.md
3. **Built-in guardrail processors with tripwires**: `PromptInjectionDetector`, `PIIDetector`, `ModerationProcessor`, `UnicodeNormalizer`, `SystemPromptScrubber`, `TokenCostControl`; strategies block/warn/detect/redact/rewrite; `tripwire` on the result or as a stream chunk. [V] https://mastra.ai/docs/agents/guardrails.md
4. **Live scorers with sampling** on production traffic (`sampling.rate`, deterministic per trace), built-in scorers, datasets, `runEvals()` for CI. [V] https://mastra.ai/docs/evals/overview.md
5. **Workflows**: graph steps with suspend/resume, human-in-the-loop, snapshots, time travel. [V] URLs listed in https://mastra.ai/llms.txt: https://mastra.ai/docs/workflows/suspend-and-resume.md , https://mastra.ai/docs/workflows/time-travel.md (bodies not read)
6. **RAG helpers**: chunking, embedding, vector stores, rerank, graph RAG. [V] URLs listed: https://mastra.ai/reference/rag/overview.md (body not read)
7. **Code Mode**: `createCodeMode()` gives the agent an `execute_typescript` tool that calls many tools in a sandbox (isolated-vm, QuickJS, E2B transports). [V] https://mastra.ai/docs/agents/code-mode.md
8. **Voice**. [V] URL listed: https://mastra.ai/reference/voice/overview.md (body not read)
9. **Auth providers and fine-grained authorisation** for the agent server (simple auth, JWT, FGA). [V] URLs listed: https://mastra.ai/docs/auth/overview.md (body not read)
10. **A2A protocol and browser tools**. [V] URLs listed: https://mastra.ai/docs/connections/a2a.md , https://mastra.ai/docs/browser.md (bodies not read)

## B4. Vercel AI SDK `ToolLoopAgent` (ai v7)

1. **DevTools local trace viewer**: `npx @ai-sdk/devtools@latest`, UI at `http://localhost:4983`, fed by the telemetry integration; requires ai v7. [V] https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/65-devtools.mdx
2. **Tool search**: `toolSearch()` with `deferLoading: true`, and a cache-preserving code mode. [V] https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/19-tool-search.mdx
3. **Code mode**: models orchestrate tools with sandboxed JS/TS. [V] https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/18-code-mode.mdx (frontmatter only)
4. **Policy-as-code tool approvals**: `@ai-sdk/policy-opa` with Rego policies, shadow mode, decisions sent to observability. [V] https://github.com/vercel/ai/blob/main/content/docs/03-agents/06-policy-tool-approvals.mdx (headings read)
5. **Signed tool approvals** (`experimental_toolApprovalSecret`) and per-request approval config. [V] https://github.com/vercel/ai/blob/main/content/docs/03-agents/06-tool-approvals.mdx (headings read)
6. **`prepareStep` per-step control**: swap model, `activeTools`, `toolChoice`, prune messages; stop conditions `isStepCount`, `hasToolCall`, custom, cost budget. Default 20 steps. [V] https://ai-sdk.dev/docs/agents/loop-control
7. **`WorkflowAgent`** (`@ai-sdk/workflow`): durable agent with tools as workflow steps and `WorkflowChatTransport` resumable streaming. [V] https://github.com/vercel/ai/blob/main/content/docs/03-agents/07-workflow-agent.mdx
8. **`HarnessAgent`**: run Claude Code, Codex or Pi behind the AI SDK agent interface. [V] https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent
9. **Realtime voice, speech, transcription, file uploads, MCP Apps** pages exist in core docs. [V] directory listing of https://github.com/vercel/ai/tree/main/content/docs/03-ai-sdk-core (frontmatter only: `36-realtime`, `37-speech`, `39-file-uploads`, `17-mcp-apps`)
10. **Terminal UI package**: `@ai-sdk/tui` `runAgentTUI()` for a local or remote agent. [V] https://ai-sdk.dev/docs/agents/terminal-ui (you have `chat`; the remote `ChatTransport` mode is the notable part)

## B5. LangGraph.js

1. **Graphs mixing deterministic and agentic steps.** [V] https://docs.langchain.com/oss/javascript/langgraph/overview
2. **`interrupt()` anywhere in a node or tool**, resumed with `new Command({ resume })`; approve/edit/reject patterns; multiple simultaneous interrupts keyed by id; static `interruptBefore`/`interruptAfter`. [V] https://docs.langchain.com/oss/javascript/langgraph/interrupts
3. **Time travel**: `getStateHistory()`, replay from a checkpoint, fork with `updateState()`. [V] https://docs.langchain.com/oss/javascript/langgraph/use-time-travel
4. **Checkpointers** (`MemorySaver`, `SqliteSaver`, `PostgresSaver`) per `thread_id`, plus a cross-thread **Store** for long-term memory. [V] https://docs.langchain.com/oss/javascript/langgraph/persistence
5. **Studio** visual debugger and local server. [V] pages exist (HTTP 200, bodies not read): https://docs.langchain.com/oss/javascript/langgraph/studio , https://docs.langchain.com/oss/javascript/langgraph/local-server
6. **Functional API, durable execution, streaming modes, test guide.** [V] pages exist (HTTP 200, bodies not read): `/functional-api`, `/durable-execution`, `/streaming`, `/test` under the same base URL
7. **Hosted deployment and observability through LangSmith.** [V] links on the overview page: https://docs.langchain.com/langsmith/deployment , https://docs.langchain.com/langsmith/observability

## B6. Strands Agents TypeScript SDK

The old repo `strands-agents/sdk-typescript` is archived and points to `strands-agents/harness-sdk`; the npm package is still `@strands-agents/sdk`. [V] https://github.com/strands-agents/sdk-typescript , https://github.com/strands-agents/harness-sdk

1. **Multi-agent Graph and Swarm patterns, handoffs.** [V] https://strandsagents.com/docs/user-guide/sdk/multi-agent/multi-agent-patterns/index.md
2. **Interventions**: one ordered control layer for authorisation, guardrails and steering with typed actions and short-circuiting; steering is "just-in-time contextual feedback" (TypeScript uses the interventions framework). [V] https://strandsagents.com/docs/user-guide/sdk/agents/interventions/index.md , `.../interventions/steering/index.md` (index line read)
3. **Snapshots**: capture and restore agent state for undo/redo and branching. [V] https://strandsagents.com/docs/user-guide/sdk/agents/snapshots/index.md (TS examples present)
4. **Context offloader plugin**: oversized tool results stored externally and referenced. [V] https://strandsagents.com/docs/user-guide/sdk/plugins/context-offloader/index.md
5. **Goal-loop plugin**: validate the answer against a goal and loop with feedback. [V] https://strandsagents.com/docs/user-guide/sdk/plugins/goal-loop/index.md
6. **Context injector plugin** (clock, environment facts folded in before each call). [V] index line in https://strandsagents.com/llms.txt
7. **Hosted tools through the OpenAI Responses provider** (web search, code interpreter); image and video input on the Google and OpenAI providers. [V] index lines in https://strandsagents.com/llms.txt
8. **A2A server and client.** [V] https://strandsagents.com/docs/user-guide/sdk/multi-agent/agent-to-agent/index.md (index line)
9. **Vended tools that run in Node and browsers** (notebook, file editor, HTTP request). [V] https://strandsagents.com/docs/user-guide/sdk/tools/vended-tools/index.md
10. **Deploy guides** for Bedrock AgentCore, Lambda, Fargate, Docker, Kubernetes, Terraform. [V] index lines in https://strandsagents.com/llms.txt (several are Python-first)

## B7. Ranked shortlist: 12 ideas most worth adopting

Ranked by user-visible gap times breadth of adoption across the field. The first four are the gaps you named.

| # | Idea | Why | Evidence |
|---|---|---|---|
| 1 | **Multimodal and file input** (image/file parts on `send()`, plus a UI file-part decoder) | Every project here accepts it, including open-harness; it is the most visible missing input type | https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.md ; open-harness `packages/core/src/messages.ts` |
| 2 | **Local trace viewer** (`npx` command, localhost UI, fed by the spans you already emit) | You have OTel spans but nothing to look at them with locally; AI SDK and Mastra both ship one command | https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/65-devtools.mdx ; https://mastra.ai/docs/studio/overview.md |
| 3 | **Hosted provider tools pass-through** (web search, code interpreter, file search, computer use) with events and approvals that account for provider-side execution | Users expect `webSearch` to be one line; OpenAI, Claude and Strands expose it | https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/tools.mdx |
| 4 | **Tool search / deferred tools** (`deferLoading`, search tool, threshold by share of context) | Three vendors converged on it this year; it pairs with your MCP client where tool counts explode | https://code.claude.com/docs/en/agent-sdk/tool-search.md ; https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/19-tool-search.mdx |
| 5 | **Session fork, resume-at-message and time travel** exposed as API and in Agent Forge | Checkpoints already exist; forking from step N is the cheapest high-value feature on top of them | https://code.claude.com/docs/en/agent-sdk/sessions.md ; https://docs.langchain.com/oss/javascript/langgraph/use-time-travel |
| 6 | **Permission modes** (`plan`, `acceptEdits`, `dontAsk`, classifier `auto`), switchable mid-run | Turns your policies into named presets users already know from Claude Code; `plan` mode is a feature in itself | https://code.claude.com/docs/en/agent-sdk/permissions.md |
| 7 | **Guardrail tripwires with parallel versus blocking mode, plus a starter set** (prompt injection, PII, moderation, cost) | You have the hook points; the field ships named processors and a typed tripwire result | https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/guardrails.mdx ; https://mastra.ai/docs/agents/guardrails.md |
| 8 | **Handoffs** (transfer the conversation to another agent, with an input filter) | Distinct from sub-agents-as-tools; the signature OpenAI pattern and also in Strands | https://openai.github.io/openai-agents-js/guides/handoffs |
| 9 | **File checkpointing and rewind** for workspace edits | Complements crash resume: undo what the agent did to disk, with a dry run | https://code.claude.com/docs/en/agent-sdk/file-checkpointing.md |
| 10 | **Semantic recall and observational memory** on top of memory slots | Mastra's observational memory is designed to keep the prompt prefix cacheable, which also answers the prompt-caching question | https://mastra.ai/docs/memory/observational-memory.md |
| 11 | **Code mode / programmatic tool calling** (one sandboxed script calls many tools) | Shipped by Mastra, AI SDK and OpenAI; you already have the Docker sandbox to run it in | https://mastra.ai/docs/agents/code-mode.md ; https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/18-code-mode.mdx |
| 12 | **Policy-as-code approvals with shadow mode** (OPA/Rego) and signed approvals | Extends your permission policies for enterprise review and safe rollout | https://github.com/vercel/ai/blob/main/content/docs/03-agents/06-policy-tool-approvals.mdx |

Next in line, not in the 12: voice/realtime (large surface: https://openai.github.io/openai-agents-js/guides/voice-agents), live scorer sampling on production traces (https://mastra.ai/docs/evals/overview.md), hosted sandbox clients such as E2B/Modal/Daytona (OpenAI `clients.mdx` above), graph workflows with `interrupt()` (https://docs.langchain.com/oss/javascript/langgraph/interrupts), prompt-cache TTL controls (https://code.claude.com/docs/en/agent-sdk/cost-tracking.md), and a todo tool with a UI hook (open-harness `create-todo-tools.ts`).

---

# Things I could not verify

1. **Whether the open-harness quickstart runs today.** Not installed or executed. The `@ai-sdk/openai@4` versus `ai@6` provider-version mismatch is inferred from `npm view` dependency data only.
2. **open-harness time-to-first-reply.** Not timed; steps are counted from the docs.
3. **PR #7 contents** ("agent tool loop options", closed 2026-07-21). I confirmed it is not on `main`; I did not read the diff.
4. **`apps/web`** (marketing site source) was not read; only `apps/docs` and `packages/*/src`.
5. **Claude Agent SDK TypeScript reference details.** The options and `Query` method lists came through a summarising fetch of a long page. The same fetch returned a built-in tool name table that looks unreliable (names such as `EditFile`, `FindReplace`), so I did not use it. Items sourced from the `.md` pages I downloaded (permissions, tool search, file checkpointing, sessions, session storage, cost tracking, streaming input) are solid.
6. **OpenAI voice agents and handoffs** class and option names came from summarising fetches of the rendered site, not the MDX source. The tools, guardrails, tracing, sessions, human-in-the-loop and sandbox pages were read from MDX source.
7. **Mastra** workflows, RAG, voice, auth, A2A and browser pages: URLs are confirmed in `mastra.ai/llms.txt` but the page bodies were not read. "Supervisor agents" appears only as a migration page URL.
8. **AI SDK** code mode, realtime, speech, file uploads, MCP Apps: only titles and descriptions were read. Whether `ToolLoopAgent` supports provider-executed tools was not checked beyond a note in the tool-approvals page that provider-executed tools bypass SDK approvals. No prompt-caching page was found in the agents section; I did not check provider pages.
9. **LangGraph.js** Studio, functional API, durable execution, streaming and test pages: confirmed to exist (HTTP 200) but not read. The `subgraphs` URL I guessed returned 404.
10. **Strands per-feature TypeScript support.** Pages I downloaded (snapshots, interventions, interrupts, goal-loop, context-offloader, vended tools) contain TypeScript examples. The voice (`BidiAgent`) overview page has zero mentions of TypeScript, so **Strands voice in TypeScript is unverified and probably Python-only**. Evals SDK and several deploy guides also look Python-first; not confirmed either way.
11. **A dashboard URL for OpenAI traces** was not captured from the tracing page.
