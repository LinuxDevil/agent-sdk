# Independent check of `@lousho/build-ai-agent` (2026-10-02)

Tree: `E:\agent-sdk\.claude\worktrees\rename-lousho`, HEAD `4ce8a4d` ("Rename loushy to lousho everywhere"), version `1.0.0-alpha.8`. Platform: Windows 11, Node 26.2.0, TypeScript 5.9.3. Nothing in the worktree was edited. `git status` showed three files as modified before I started and still does (`bin/lousho.js`, `packages/create-lousho-agent/bin/cli.js`, `src/cli/init/__snapshots__/templates.test.ts.snap`); `git diff --stat` prints only CRLF warnings for them, so they are line-ending noise, not content changes.

Marking: **[V]** = verified by me (file:line read, or a command I ran, output kept in this folder); **[I]** = inferred (from docs text, a test's header comment, or the tracker) and not run.

Paths are relative to the worktree unless they start with `audit2/`.

## Headline

- The tracker's score is 48 ✅ / 2 ⚠️ / 1 ❌. My score with the stricter rule (exported + documented + tested, and no documented limit a user would hit) is **40 ✅ / 10 ⚠️ / 1 ❌**. I disagree with ✅ on 8 rows: Durable stores, Sandboxing, Background sub-agents, Multi-provider, Multimodal input, Edge runtime, Credential brokering, Registry.
- The DX claim holds and is now measured: the three reference agents are **17 / 27 / 22 LOC** with **3 / 4 / 4 imported identifiers** (was 17 / 57 / 55 and 3 / 11 / 10). All three type-check against `src/` and against `dist/`, and (b) and (c) ran end to end against the built `dist` with a scripted `mockModel`.
- Lint and typecheck are clean. The full test run is not reliably green on this machine: the first run died with a native crash (exit 127, no output), and the crash left a lock that made 5 deploy test files time out in the second run. Those 13 deploy files pass when run alone.
- The public surface is very large: **705 root exports**, of which docs snippets import 123.

## 1. Feature matrix, "us" column

Rule used: ✅ only if the feature is reachable from a package entry point, has a docs page or section, and has a test; ⚠️ if it exists but a user hits a documented limit quickly, or the part that matters was only exercised against a fake. "Tracker" is the cell in `STATE.md` lines 34-84.

| # | Capability | Tracker | Mine | Evidence | Caveat (one line) |
|---|---|---|---|---|---|
| 1 | Durability / resume | ✅ | ✅ | `src/createAgent.ts:543` (`resume`), `docs/durable-execution.md:22-41`, `src/session/durableSession.test.ts`, `src/createAgentStore.test.ts`; my crash/resume/continue run on `dist` [V] | Tools are at-least-once; a turn resumed inside `send()`/`stream()` is not streamed (`docs/sessions.md:170-172`); an aborted turn is dropped. |
| 2 | Durable stores (SQLite / file / KV) | ✅ | **⚠️** | `src/storage/sqlite/SqliteStore.ts:48` (subpath `/sqlite`), `src/session/sessionStore.ts:106`, `src/deploy/kvStore.ts:105` [V] | SQLite is solid. `KVStore` and `KVCheckpointStore` are in no entry point (0 hits in the 705 root exports, no subpath, no tsup entry), yet `docs/deployment.md:202-204` tells users to write `new KVStore(env.AGENT_CHECKPOINTS)` in their own Worker. There is no ready-made file `AgentStore`: three classes plus the donor `StorageService(userId, folder, fs, path)` must be assembled by hand (`docs/sessions.md`, "Choosing a store"). |
| 3 | Sandboxing | ✅ | **⚠️** | `src/security/sandbox.ts:17-31`, `src/security/sandboxEgress.ts`, `docs/workspace-tools.md:276-292` [V] | Real-daemon tests were skipped in my run (2 in `SubprocessSandbox.test.ts`, 1 in `deploy/adapters/docker.test.ts`); egress is tested against a fake dockerode (`sandboxEgress.test.ts:4`); egress is refused on Docker Desktop (Windows, macOS), rootless Docker and remote daemons. Opt-in. |
| 4 | Workspace fs + shell tools | ✅ | ✅ | `src/tools/workspace/fsTools.ts:181`, `shellTool.ts:154`, `NodeWorkspace.ts:117`, `docs/workspace-tools.md`; my coding-agent run [V] | One symlink confinement test is skipped on Windows; the guide's first snippet uses `AgentExecutor` + `ToolRegistry`. |
| 5 | Compaction | ✅ | ✅ | `src/context/compaction.ts:299`, `src/createAgent.ts:369`, `docs/compaction.md:12`, 3 test files in `src/context/` [V] | README still describes it only as `createCompactionHook()` (`README.md:90,191`). |
| 6 | Sub-agents | ✅ | ✅ | `src/createAgent.ts:155`, `src/subagents/withSubagents.ts:410`, `docs/sub-agents.md`, `src/subagents/subagents.test.ts` [V] | - |
| 7 | Background / resumable sub-agents | ✅ | **⚠️** | `src/subagents/backgroundTasks.ts:2-23`, `backgroundSubagents.test.ts`, `resumableSubagents.test.ts` [V] | A background sub-agent that needs approval stops and cannot be resumed; a lead pause cancels its background tasks (`docs/sub-agents.md:225-234`); failed or cancelled tasks cannot be continued (`:129-130`). The shell tool asks for approval by default, so a coding sub-agent hits this at once. |
| 8 | Remote sub-agents | ✅ | ✅ | `src/subagents/remoteAgent.ts:82`, `docs/sub-agents.md:280-296`, `remoteAgent.test.ts` [V] | Tested through an injected `fetch` against in-process routes [I]; a remote task cannot be forked (`:288`). |
| 9 | Approvals / HITL | ✅ | ✅ | `src/createAgentApprovals.ts:73` (`streamResolve`), `docs/approvals.md:250-272`; my run: safe command ran, destructive one paused, `y` continued streamed, `n` rejected [V] | `approve` callback does not apply to `stream()`; `list()` only knows this process's pauses; after a restart you must `resume()` the session before resolving (`docs/sessions.md:173-181`). |
| 10 | Agent asks the user a question | ✅ | ✅ | `src/tools/built-in/askQuestion.ts:51`, `src/createAgent.ts:300`, `docs/approvals.md:263+`, `askQuestion.test.ts` [V] | In Slack/Discord a pending question is lost on restart (`docs/channels.md:228,266`). |
| 11 | Steering | ✅ | ✅ | `src/execution/agentRun.ts:102,530`, `src/session/AgentSession.ts:64,474`, `docs/streaming.md:36,56`, `src/execution/steering.test.ts` [V] | - |
| 12 | Cancellation | ✅ | ✅ | `src/createAgent.ts:466`, `src/execution/cancellation.test.ts` [V] | - |
| 13 | Memory (cross-session) | ✅ | ✅ | `src/memory/defineMemory.ts:79`, `src/storage/sqlite/sqliteMemory.ts:20`, `docs/memory.md`, `memory.test.ts`, `sqliteMemory.test.ts` [V] | - |
| 14 | Sessions | ✅ | ✅ | `src/session/AgentSession.ts`, `docs/sessions.md`, 4 test files in `src/session/` [V] | Two concurrent runs on one id are not supported (`docs/durable-execution.md:390-391`). |
| 15 | Skills | ✅ | ✅ | `src/skills/loadSkills.ts:112`, `docs/skills.md`, `skills.test.ts` [V] | - |
| 16 | AGENTS.md loading | ✅ | ✅ | `src/projectInstructions.ts:67`, `src/createAgent.ts:261`, `docs/configuration.md:460` [V] | Off by default. |
| 17 | Evals | ✅ | ✅ | `src/evals/defineEval.ts:248`, `src/cli/eval.ts`, `docs/evals.md`, 6 test files in `src/evals/` [V] | - |
| 18 | Eval against deployed URL | ✅ | ✅ | `src/evals/remoteTarget.ts:71`, `remoteTarget.test.ts` [V] | `--url` cannot be combined with `--record`, `--replay` or `--drift` (`docs/evals.md:316`). |
| 19 | Test utils | ✅ | ✅ | `src/testing/mockModel.ts:337`, `recordReplay.ts:450` (subpath `/testing`), `docs/testing.md`; 92 test files use `mockModel` [V] | - |
| 20 | Tracing / OTel GenAI | ✅ | ✅ | `src/execution/genAiSpans.ts`, `src/execution/otel.ts` (subpath `/otel`), `docs/observability.md`, `otel.test.ts` [V] | - |
| 21 | Metrics / trace viewer | ⚠️ | ⚠️ | Metrics: `src/execution/otel.ts:173-178`. No viewer: the CLI has no such command (`bin/lousho.js:88-97`) [V] | Agree. |
| 22 | Multi-provider | ✅ | **⚠️** | `src/providers/resolveProvider.ts`, `docs/providers.md:138-153` [V] | Four named providers only. There is no way to pass an AI SDK model: `AiSdkProvider` is not exported and `createModel` is abstract (`src/providers/aiSdkProvider.ts:242`), so Google, Bedrock, Azure or Mistral means hand-writing an `LLMProvider`. `ai` 6 is tested with a "v6-shaped stand-in" (`src/providers/aiMajorPeers.test.ts:5,15`), not the real package; no test calls a real API. |
| 23 | Fallbacks / retry | ✅ | ✅ | `src/providers/resilience.ts:125,185`, `src/createAgent.ts:315,327`, `resilience.test.ts`, `createAgentResilience.test.ts` [V] | - |
| 24 | Structured output | ✅ | ✅ | `src/createAgent.ts:343`, `docs/structured-output.md`, `structuredOutput.test.ts` + `.test-d.ts` [V] | - |
| 25 | Multimodal input | ✅ | **⚠️** | `src/providers/aiSdkProvider.ts:249,265`, `docs/providers.md:119-129` [V] | Images work. Files are never sent by any built-in provider: `acceptsFileParts` defaults to `false` and nothing in `src/providers` overrides it, so a PDF becomes a text note on every `ai` major. The tracker says this only happens "on the pinned `ai` v4 peers". |
| 26 | Reasoning control / events | ✅ | ✅ | `src/createAgent.ts:234`, `src/execution/streamStep.ts:67`, `docs/reasoning.md`, `reasoning.test.ts` [V] | Ignored for Ollama on `ai` 4 (`docs/reasoning.md:55`); OpenAI encrypted items not carried (`:107`); cannot be a per-run function. `docs/providers.md:214-216` still says reasoning deltas "are not reported yet", which is now false. |
| 27 | MCP client | ✅ | ✅ | `src/tools/mcp/connect.ts:132`, `src/createAgent.ts:119`, `connect.test.ts:35` (a real stdio server) [V] | Documented inside `configuration.md`, no page of its own. |
| 28 | MCP server | ✅ | ✅ | `src/tools/mcp/server/serveMcp.ts:127`, `src/cli/mcp.ts` [V] | Approval-gated tools cannot be approved over MCP (`docs/configuration.md:296`). |
| 29 | Typed event stream | ✅ | ✅ | `src/execution/agentEvents.ts:403-422`, `agentEvents.test-d.ts`, `docs/streaming.md` [V] | - |
| 30 | UI bindings React / Vue / Svelte | ✅ | ✅ | `src/react/useLoushoAgent.ts:34`, `src/vue/useLoushoAgent.ts`, `src/svelte/loushoAgent.ts`, one test + one type test each [V] | `docs/vue.md` (62 lines) and `docs/svelte.md` (67) are thin and missing from the README docs table. |
| 31 | AI SDK UI stream | ✅ | ✅ | `src/server/uiMessageStream.ts:168`; the test reads the stream with the real `readUIMessageStream` of `ai` 7 (`uiMessageStream.test.ts:3,90`) [V] | - |
| 32 | CLI scaffolding | ⚠️ | ⚠️ | `src/cli/init.ts`; `npm view @lousho/build-ai-agent` and `npm view create-lousho-agent` both return E404 today [V] | Agree. |
| 33 | Dev TUI / REPL | ✅ | ✅ | `src/cli/chat.ts`, `chatRepl.ts`, `src/cli/dev.ts`, `chat.test.ts`, `dev.test.ts` [V] | A line REPL, not a TUI. README's feature list and `docs/installation.md` omit `chat`. |
| 34 | Visual studio / debugger | ✅ | ✅ | `apps/agent-forge/`, `docs/agent-forge.md`, `src/cli/studio.test.ts` [V] | `apps/agent-forge/dist` is not built in this worktree, so I could not check that `lousho studio` works from the packed tarball. |
| 35 | Channels | ✅ | ✅ | `src/channels/slackChannel.ts:134`, `discordChannel.ts:145`, `defineChannel.ts:169`, `docs/channels.md`, 4 test files [V] | Slack and Discord are tested against fakes only [I]; function-form `approvers` fail closed after a restart (`docs/channels.md:198`). |
| 36 | Schedules | ✅ | ✅ | `src/schedules/startSchedules.ts:71`, `defineSchedule.ts:64`, Worker crons `src/deploy/adapters/cloudflare.ts:131-158`, `docs/schedules.md` [V] | In-process timer: fires missed while the process was down are skipped (`docs/schedules.md:43`). |
| 37 | Deploy story | ✅ | ✅ | `src/deploy/adapters/{node-server,docker,cloudflare}.ts`; node-server tests start a real subprocess; 13 deploy files, 96 tests pass when run alone [V] | Docker image test skipped (no daemon). `lousho build` takes a spec file or an agent directory, not a code-first `createAgent()` module [I from `node-server.ts:52`]. |
| 38 | Edge runtime (Workers) | ✅ | **⚠️** | `src/deploy/adapters/cloudflare.ts`, tests run the bundle in real `wrangler dev` (`cloudflare.test.ts:10-16`) [V] | The Worker target takes spec files only (agent directories are node-server/docker only, `docs/deployment.md:26`), supports the `mock`, `openai` and `anthropic` providers and exactly two tools, `current-date` and `day-name` (`docs/deployment.md:150-168`). A hand-written Worker cannot import `KVStore` (row 2). |
| 39 | Budgets / limits | ✅ | ✅ | `src/execution/budget.ts:15-19,58`, `src/createAgent.ts:182`, `budget.test.ts` [V] | - |
| 40 | Guardrails (input / output) | ✅ | ✅ | `src/execution/ioGuardrails.ts:43`, `src/createAgent.ts:193`, `docs/guardrails.md:61-77`, `ioGuardrails.test.ts` [V] | - |
| 41 | Permissions policy | ✅ | ✅ | `src/execution/permissions.ts:99`, `src/createAgent.ts:610-611`, `docs/approvals.md:60-120`, `permissions.test.ts` [V] | - |
| 42 | Credential brokering | ✅ | **⚠️** | `src/security/credentialBroker.ts:266`, `credentialBroker.test.ts`, documented only as a section of `docs/workspace-tools.md` [V] | Enforced only with Docker Engine on Linux with the agent on the same host; refused elsewhere (`docs/workspace-tools.md:276-292`); container path tested against a fake daemon. |
| 43 | Dynamic config | ✅ | ✅ | `src/createAgent.ts:87,107,396,429` (`PerRun<T>`), `src/dynamicConfig.test.ts` + `.test-d.ts` [V] | `reasoning` is not `PerRun` (`src/createAgent.ts:234`). |
| 44 | Hot reload | ✅ | ✅ | `src/cli/devReload.ts:213-224`, `src/cli/dev.test.ts:144` [V] | - |
| 45 | Registry / extensions | ✅ | **⚠️** | `src/cli/add.ts:76-113`, `src/cli/registry.ts:40`, `docs/registry.md` [V] | The permission manifest is displayed, not enforced (`docs/registry.md:90`), and there is no hosted registry, so `lousho add` has nothing to install from until the user builds one. |
| 46 | ACP | ✅ | ✅ | `src/acp/serveAcp.ts:108`, `src/cli/acp.ts`, `docs/acp.md`, `serveAcp.test.ts` [V] | No `session/load`, no `fs/*` or `terminal/*`, text prompts only (`docs/acp.md:97-106`); not run against a real editor. |
| 47 | Code-first authoring | ✅ | ✅ | `src/createAgent.ts:593` [V] | - |
| 48 | Directory authoring | ✅ | ✅ | `src/agentDir/loadAgentDir.ts:281`, `docs/agent-directories.md`, 4 test files [V] | - |
| 49 | Agent-readable docs | ✅ | ✅ | `llms.txt` (58 lines), `llms-full.txt` (10,289 lines, 531 KB), `docs/*.md`, all in the tarball (`audit2/pack.json`) [V] | - |
| 50 | Published on npm | ❌ | ❌ | `npm view` returns E404 for both packages [V] | Agree. |
| 51 | Current `ai` major | ✅ | ✅ | `package.json` peer `ai: ^4.3.19 \|\| ^6.0.0 \|\| ^7.0.0`; v7 stream tests use the real `ai-v7` alias (`aiSdkCompat.stream.v7.test.ts:11-13`) [V] | The repo's own suite runs on `ai` 4 (devDependency `ai ^4.3.19`); v6 is a stand-in. |

Tracker-listed limits I confirmed in source or docs: resumed-turn events not streamed, Docker features tested against a fake, registry manifest not enforced, ACP gaps, channel restart behaviour, failed tasks not resumable, test-only files in `files`, native vitest crash on Node 26 / Windows. Tracker-listed limits I did not check: nested fingerprints not compared on resume, remote sub-agent usage not added to the lead's totals (the docs at `docs/sub-agents.md:78` say sub-agent usage is added, with no remote exception), `skipLibCheck: false` consumers.

## 2. Reference agents against the current API

Files: `audit2/reference-agents/lousho/{chat.ts,coding.ts,durable-job.ts}`. Metric definitions are the audit's: LOC = non-blank, non-comment lines; identifiers and specifiers exclude `node:*`. Counted by `audit2/metrics.cjs`.

| Agent | LOC (old) | Imported identifiers (old) | Import specifiers | tsc vs `src/` | tsc vs `dist/` | Ran |
|---|---|---|---|---|---|---|
| (a) chat | **17** (17) | **3** (3): `z`, `createAgent`, `defineTool` | 2 | pass | pass | not run (needs an API key) |
| (b) coding | **27** (57) | **4** (11): `NodeWorkspace`, `createAgent`, `createFsTools`, `createShellTool` | 1 (2 with `node:readline/promises`, 5 identifiers with `createInterface`) | pass | pass | yes, with `mockModel` |
| (c) durable job | **22** (55) | **4** (10): `z`, `createAgent`, `defineTool`, `SqliteStore` | 3 | pass | pass | yes, with `mockModel` |

- Type-check [V]: `node_modules/.bin/tsc -p audit2/tsconfig.json` (paths to `src/index.ts` and `src/storage/sqlite/index.ts`) exit 0; `tsc -p audit2/tsconfig.dist.json` (paths to `dist/*.d.ts`) exit 0.
- Behaviour [V], in `audit2/behavior/` (junctions to the built package, model replaced by a scripted `mockModel`):
  - (b) `echo safe` ran without a prompt; `echo hi > out.txt` paused, `y` ran it and the continuation streamed; `write_file` paused, `n` rejected it (no `note.txt`), and the final text streamed.
  - (c) `CRASH_AT=1 ... start` exited 1 mid-run; `resume` finished the turn (`stop Total rows: 3000`); a second `resume` returned `null`; `continue "Now write a summary"` appended a turn to the same session.
- (b) no longer needs `AgentBuilder`, `AgentExecutor`, `AgentType`, `ToolRegistry`, `resolveProvider`, `resumeAfterApproval` or an approval store. The continued run is streamed with `agent.approvals.streamResolve()`.
- (c) is the same file the loop committed in `e97eaaa` (only the package name changed); it measures 22 by this metric. The loop's copy of `coding.ts` in `.agent-loop/reference-agents/loushy/` was never rewritten and is still the 57-line version, so the (b) number had not been re-measured before today.
- Things I hit while writing them:
  - Top-level `await` in a `.ts` file fails under `tsx` unless the project is ESM (`"type": "module"`) or the file is `.mts`. Docs snippets are `.mts`; the README quickstart does not say so.
  - After `streamResolve()`, the decided call's `tool.start` is emitted again (documented at `docs/approvals.md:253-256`), so a naive printer shows the call twice.
  - `agent.resume(id)` returns `null` when nothing is pending, so the script prints `undefined undefined`.

## 3. API surface and quality numbers

| Metric | Value | How |
|---|---|---|
| Root exports | **705** (265 values, 440 types; 10 marked `@deprecated`) | TS checker over `dist/index.d.ts` (`audit2/count-exports.cjs`, list in `audit2/root-exports.json`) [V] |
| Subpath exports | **13** (14 entries with `.`): `./core` 1, `./tools` 104, `./flows` 18, `./mcp` 21, `./types` 64, `./testing` 15, `./otel` 2, `./hooks` 11, `./sqlite` 5, `./triggers` 30, `./react` 17, `./vue` 17, `./svelte` 17 | same script [V] |
| Non-test LOC in `src/` | **45,579** lines in 298 files (41,576 non-blank) | excludes `*.test.ts(x)`, `*.test-d.ts`, `*.testkit.ts`, `*.eval.ts`, `__fixtures__`, `__snapshots__` [V] |
| Test files | **200** `*.test.ts(x)` in `src/`, plus 11 `*.test-d.ts`, 5 `*.eval.ts`, 3 `*.testkit.ts`; vitest collects **213** files (201 in `src/`, 12 in `examples/`, `docs/`, `scripts/`, `packages/`) | `find`, `audit2/vitest.json` [V] |
| Test cases | **2,959** (2,867 in `src/`) | `audit2/vitest.json` [V] |
| Test result | Run 1: process died, exit 127, no summary (`audit2/vitest.log`). Run 2: 208 files passed, 5 failed; 2,929 passed, 1 failed, 4 skipped (`audit2/vitest2.log`). The 5 failures are all `src/deploy/adapters/*` hook or test timeouts at 120 s. Re-run of `src/deploy` alone: 13 files, 96 passed, 1 skipped (`audit2/vitest-deploy.log`) | `CI=1 npx vitest run` [V] |
| `npm run lint` | exit 0, 0 warnings (`eslint src --max-warnings 0`) | `audit2/lint.log` [V] |
| `tsc --noEmit` | exit 0 | [V] |
| Explicit `any` outside tests | **1**: `src/execution/AgentExecutor.ts:161` (a deprecated public type, with the only `eslint-disable` in non-test source). Also 8 `as unknown as`, 0 `@ts-ignore` / `@ts-expect-error` | grep; `no-explicit-any` is `error` (`eslint.config.mjs:17`) [V] |
| Packed tarball | **3,170,128 bytes** (3.02 MiB) | `npm pack --dry-run --json --ignore-scripts` (`audit2/pack.json`) [V] |
| Unpacked size, file count | **11,690,649 bytes** (11.1 MiB), **715 files** | same [V] |
| What the bytes are | `dist/` 355 files, 8.58 MB, of which 138 `.map` files are 5.53 MB; `src/` 314 files, 1.91 MB; `llms-full.txt` 531 KB; `docs/` 37 files, 493 KB; `CHANGELOG.md` 122 KB | same [V] |

Test-only files that ship (15 files, 57,821 bytes) [V]:

- `src/cli/init/__snapshots__/templates.test.ts.snap`
- `src/deploy/buildLock.testkit.ts`, `src/providers/aiMajor.testkit.ts`, `src/providers/aiShapes.testkit.ts`
- `src/dynamicConfig.test-d.ts`, `src/execution/agentEvents.test-d.ts`, `src/execution/hooks.test-d.ts`, `src/execution/structuredOutput.test-d.ts`, `src/flows/flowTypes.test-d.ts`, `src/react/react.test-d.ts`, `src/session/outputTyping.test-d.ts`, `src/storage/StorageService.test-d.ts`, `src/svelte/svelte.test-d.ts`, `src/tools/defineTool.test-d.ts`, `src/vue/vue.test-d.ts`

This matches the tracker's count (11 + 3 + 1, about 58 KB).

Notes on these numbers:

- **The tarball measured here has no Agent Forge.** `files` lists `apps/agent-forge/dist` and `dist-server`, but neither exists in this worktree, so only `apps/agent-forge/package.json` was packed. A real publish runs `build:studio` in `prepublishOnly` and will be larger. I did not build it (it would write into the worktree).
- **The test failures have one cause, and it is the known one.** `src/deploy/buildLock.testkit.ts:15-27` takes a machine-wide lock in the OS temp directory that is only treated as stale after 3 minutes. Run 1 crashed natively (the comment at lines 4-9 describes exactly this exit code) while holding it; run 2 started about a minute later and its deploy suites waited on the dead lock until their 120 s timeout. So one native crash turns the next run red too.
- 47% of the unpacked size is source maps, and `src/` ships next to `dist/`.

## 4. Rough edges for a new user

### README.md (268 lines)

1. **Install commands disagree.** `README.md:40-42` says `npm install @lousho/build-ai-agent ai zod` plus `@ai-sdk/openai`, `@ai-sdk/anthropic` or `ollama-ai-provider`. Unpinned `ai` installs v7, and `ollama-ai-provider` only pairs with `ai` 4 (`docs/installation.md:43-47`). `docs/quick-start.md:44-45` pins `ai@^7.0.0` and `@ai-sdk/openai@^4.0.0`.
2. **CLI list is stale.** `README.md:98` and `docs/installation.md:176-177` list `init, doctor, dev, mcp, eval, build, studio`. The CLI also has `chat`, `acp` and `add` (`bin/lousho.js:88-97`); the README table at 222-231 has `chat` but not `acp` or `add`.
3. **Durable execution is described with the low-level API**: "`sessionId` + `checkpointStore`" (`README.md:82`), while the usage example 60 lines later uses `store` and `agent.resume()`.
4. **Compaction** is described as `createCompactionHook()` (`README.md:90,191`); `createAgent({ compaction })` exists (`docs/compaction.md:12`).
5. **Docs table is incomplete**: no rows for Vue, Svelte or Registry, although those pages exist and the feature list links them.
6. **Status section is stale** (`README.md:251-257`): the "known gaps" are a POSIX process-group detail and "in-browser Quick Start snippets", not the real limits (trace viewer, Docker Desktop, files in multimodal input, Worker tool set). It links `docs/plan/tickets.md` and `docs/eslint-baseline-followup.md` (line 264); neither ships in the package (`files` has `docs/*.md` minus that one), so both links are dead on npm. The ESLint follow-up note is obsolete now that lint is at zero.
7. "Cloudflare KV for checkpoints" (`README.md:17`): `KVStore` holds sessions and approvals too (`docs/deployment.md:185`), and it cannot be imported (section 1, row 2).
8. The quickstart uses top-level `await` without saying the file must be ESM.
9. `MIT © Build AI Agent` (line 268) while `package.json` says "Lousho Team".
10. "Not on npm yet" at `README.md:33-36` and 254: expected today.

### docs/quick-start.md (235 lines)

1. **Section 4, "Full control: `AgentBuilder` + `AgentExecutor`"** (lines 155-187) says to use them "when you need the full set of execution options (`maxSteps`, `temperature`, `onAgentEvent`, approvals, checkpoints, tracing)". `createAgent()` has `maxSteps`, `approvals`, `store`, `onEvent`, `hooks` (`src/createAgent.ts:169-384`). This paragraph sends newcomers to the legacy API for things the new one does.
2. **The quick start never shows streaming, sessions or approvals**, the three things the README leads with. It goes hello world, custom provider, tools, `AgentExecutor`, spec files.
3. Section 2 ("When you need a custom provider") comes before tools; a newcomer needs neither `resolveProvider()` nor the mock provider yet.
4. Line 148-149 introduces a second tool format (`tools: { current_date: currentDateTool }`, keyed record) right after teaching the array form, and line 151 adds `ToolRegistry`.
5. The opening paragraph is about how the snippets are verified (`.mts`, `verify-docs-snippets.ts`), which is maintainer information.
6. "Not on npm yet" box at lines 12-16: expected today.

### docs/installation.md (241 lines)

1. **"Three heavier packages are optional peers"** (line 80): `package.json` has eleven optional peers, including `@opentelemetry/api`, `tsup`, `react` and `vue`, which the table omits.
2. The MCP row says the SDK enables "the `Client` you connect before `loadMcpTools()`" (line 87). That is the old path; `mcpServers` / `connectMcp()` replaced it.
3. Line 178 says building needs `npm install --save-dev tsup`; `tsup` is declared as a peer.
4. The `lousho doctor` sample output (lines 190-204) shows `ai` 4.3.19 with a fix of `npm install zod@^4.0.0`, while line 37-38 says to pair zod 4 with `ai` 6 or 7.
5. Node 22.19 is required for everyone because of `undici@8` (line 5), which line 102-105 says is only loaded for `http` requests with `validateSSL: false`.
6. Ticket ids leak into user text ("LOU-D29", line 53). Same in `docs/providers.md` (4), `docs/channels.md` (2), `docs/utilities.md` (1).
7. An HTML comment for maintainers ("AFTER PUBLISH...", lines 123-124) is in the shipped page.
8. A full section on the ESM/CJS dual-package hazard (lines 108-119) sits between install and scaffolding.

### Legacy API in the guides

Counted with `audit2/docs-imports.cjs` (every `import { ... } from '@lousho/build-ai-agent...'` in `docs/*.md` and `README.md`; all imported names do exist in the matching entry point) [V]:

- **`AgentExecutor` is imported in snippets of 14 guides**: api-overview, approvals, compaction, durable-execution, guardrails, observability, providers, quick-start, sessions, skills, streaming, structured-output, sub-agents, workspace-tools. It is mentioned 15 times in `durable-execution.md` and 10 times each in `streaming.md` and `sub-agents.md`.
- `AgentBuilder` is imported in 3 (providers, quick-start, structured-output); `ToolRegistry` in 3 (sub-agents, tools, workspace-tools); `resumeAfterApproval` in 3 (approvals, durable-execution, sub-agents).
- **Two guides open with the legacy path**: `docs/durable-execution.md:3-20` (first sentence and first snippet are `AgentExecutor.execute({ sessionId, checkpointStore })`; `createAgent({ store })` comes second) and `docs/workspace-tools.md:10-20` (`AgentExecutor` + `ToolRegistry` + `resumeAfterApproval`).
- `docs/testing.md:37-56` teaches the legacy tool record (`tools: { get_weather: { displayName, tool: { description, parameters, execute } } }`) in its first tool example instead of `defineTool()`.
- `AgentType` is no longer imported anywhere in the docs (one mention in `api-overview.md`).

### Stale or wrong statements elsewhere

- `docs/providers.md:214-216`: "Reasoning deltas are not reported yet (no reasoning chunk type until LOU-V13)". They are (`src/execution/streamStep.ts:67`, `docs/reasoning.md`).
- `docs/providers.md:124-126`: files "cannot be sent by the built-in providers' `ai` SDK peers (`@ai-sdk/openai` / `@ai-sdk/anthropic` 0.0.x ...)". The limit is real on every major (row 25), but the text reads as if newer peers fix it.
- `docs/deployment.md:202-204`: `new KVStore(env.AGENT_CHECKPOINTS)` "in a Worker you write", citing a source path; there is no import path.
- `CHANGELOG.md:3`: "changes to @lousho/build-ai-agent/sdk" (no such package). The file is 188 lines but 122 KB.
- `README.md:206`: `docs/utilities.md` is described as "Encryption, file storage and templates"; the templates engine is gone and the page no longer covers it.

### Pages that are too long

`docs/api-overview.md` 873 lines, `docs/errors.md` 727, `docs/configuration.md` 603, `docs/streaming.md` 572, `docs/sub-agents.md` 502, `docs/workspace-tools.md` 471. `configuration.md` holds MCP client, MCP server, retries and the full option tables; `api-overview.md` holds triggers, todo tools, hooks and the flow expression language.

### Missing guides

- MCP (client and server) has no page; it is two sections of `configuration.md`.
- Hooks: there is a `./hooks` subpath and no `hooks.md`.
- Triggers: a `./triggers` subpath, documented only in `api-overview.md`.
- A "build a coding agent" walkthrough: workspace tools + approvals + `streamResolve()` + a session. The pieces are on three pages; the 27-line agent in section 2 is not in the docs.
- A migration page from `AgentBuilder` / `AgentExecutor` / `resumeAfterApproval` to `createAgent()`.
- Adding a provider other than the four built-in ones.
- A Cloudflare Workers page that states the provider and tool limits up front.
- Troubleshooting / FAQ beyond `lousho doctor`.

### `TODO`, `FIXME`, `not yet`, `planned`, `unsupported`, `not supported`

- **Source**: no `TODO`, `FIXME`, `XXX` or `HACK` comment in non-test `src/` (every hit for "todo" is the todo tool) [V].
- **User-visible in source**:
  - `src/deploy/adapters/cloudflare.ts:266`: "provider '...' is not supported by the cloudflare-worker target yet".
  - `src/deploy/shims/sandboxCore.worker.ts:17`: "Sandboxed tool execution is not supported on Cloudflare Workers".
  - `src/security/sandboxEgress.ts:42-117`: `LOUSHO_SANDBOX_EGRESS_UNSUPPORTED` (Docker Desktop, rootless, remote daemon, old Engine).
  - `src/execution/guardrails.ts:112`: comment "LOU-J (not yet landed) is expected to define the real ProposedAction", a stale internal note in an exported module.
  - `src/providers/providerSpec.ts:13`: "`ai` 5 is not supported".
- **User-visible in docs**:
  - `docs/acp.md:97-106`: "Not supported" list (session/load, fs/terminal, non-text prompts, plan updates, `allow_always`, auth).
  - `docs/deployment.md:155-168`: `ollama`, `openrouter` and the `http` tool not supported on Workers.
  - `docs/providers.md:124` (files), `:215` (stale reasoning line), `:223` and `docs/installation.md:27` (`ai` 5).
  - `docs/durable-execution.md:390-391`: two concurrent `execute()` calls on one `sessionId`.
  - `docs/sub-agents.md:129-130, 225-234, 288`: failed tasks, background approvals, remote fork.
  - `docs/approvals.md:372`, `docs/configuration.md:296`: approvals over MCP.
  - `docs/evals.md:316`: `--url` with `--record` / `--replay` / `--drift`.
  - `docs/workspace-tools.md:194`: hard links outside the root cannot be detected.
  - `README.md:257`: "planned work is in the ticket catalogue" (dead link in the package).

## 5. Legacy surface

The old audit's removals are done: `src/templates/`, `src/data/`, `MemoryManager`, `ContextBuilder`, `ConfigManager`, `retry.ts`, `quotas.ts` and `flows/converters.ts` no longer exist [V]. What is left, all still exported from the package root:

| Module | Non-test LOC | Root exports | Does a guide depend on it? | Recommendation before 1.0 |
|---|---|---|---|---|
| Flows: `src/flows/` (`FlowBuilder`, `FlowExecutor`, `safeExpression`, validators) + `src/types/flow.ts` | 1,912 + 317 | about 25 (`FlowBuilder`, `FlowExecutor`, `FlowExecutionError`, `validateFlow`, flow types, `FlowAttr`) | `docs/flows.md` (62 lines), `api-overview.md`; Agent Forge and examples use `FlowExecutor` (11 files) | **Subpath only.** `./flows` already exists; drop `export * from './flows'` from the root. Cannot be removed while Forge depends on it. |
| `AgentBuilder` (`src/core/AgentBuilder.ts`) | 204 | 1 (and it is the whole `./core` subpath) | quick-start section 4, providers, structured-output; 10 non-test source files use it internally | Keep internal, mark `@deprecated` in the root, rewrite the three guide snippets to `createAgent()`. Remove the one-export `./core` subpath or give it a purpose. |
| `AgentType` and registry (`src/agent-types/`) | 118 | 8, all already `@deprecated` | none (one mention in `api-overview.md`) | **Remove.** Nothing documents it and it is already deprecated. |
| `AgentExecutor` (static API), `resumeAfterApproval`, `streamResumeAfterApproval`, `ToolRegistry` | `AgentExecutor.ts` 1,518 | 4 + their option types | 14 guides import `AgentExecutor` | Keep (it is the engine), but move it to an "advanced" page and stop opening guides with it. A `./executor` or `./advanced` subpath would shrink the root. |
| `ExecutionEvent`, `ExecutionEventType` (`src/execution/legacyEvents.ts`) | 75 | 2, `@deprecated`; holds the one `any` | none | Remove at 1.0. |
| `EncryptionUtils`, `DTOEncryptionFilter`, `sha256` (`src/security/crypto.ts`) | 294 | 5 | `docs/utilities.md` only; one internal user | **Subpath (`./utils`) or remove.** Not agent functionality. |
| `StorageService` (`src/storage/StorageService.ts`, `types.ts`) | 240 + 77 | 3 (`StorageService`, `IStorageService`, `StorageServiceApprovalStore`) | utilities, sessions, approvals; it is the only way to get file checkpoints and file approvals | Replace with a `fileStore(dir)` `AgentStore`, then move `StorageService` out of the root. Its `(userId, folder, fs, path)` constructor is donor-era. |
| Repository interfaces (`src/types/repository.ts`: `IRepository`, `IAgentRepository`, `ISessionRepository`, `IResultRepository`) | 72 | 4 | none | **Remove.** No implementation left since `src/data/` was deleted. |
| Jira tools (`src/tools/built-in/jira.ts`) | 1,167 | 6 (`createJiraTools`, `JiraTools`, `JiraConfig`, `JiraTicket`, `JiraComment`, `JiraTransition`) | one line in `docs/tools.md`; no example | **Subpath (`./tools/jira`) or a separate package.** |
| GitHub tools (`src/tools/built-in/github.ts`) | 1,661 | 7 | used by the ops-pipeline example [I] | Same: subpath. Together with Jira this is 2,828 lines, 6% of `src/`, in every root import's type surface. |
| Slack alert tool and email tool (`slack.ts`, `email.ts`) | 208 + 121 | 9 | `emailTool` appears as a variable name in `approvals.md`; `slackTool` in 5 example files | Subpath with the other integrations. |
| Triggers (`src/triggers/`: webhook, Slack, cron adapters, `TriggerRegistry`) | 1,332 | re-exported in part through spec types; own `./triggers` subpath (30 exports) | `api-overview.md#triggers`; 2 example files | Already a subpath. It overlaps with channels (Slack) and schedules (cron); decide which one survives and document one. |
| Delegation (`DelegationTool.ts`, `delegation.ts`: `createDelegateTool`, `DelegationDepthExceededError`) | 409 | 5 | none; superseded by `subagents` | Deprecate in favour of `subagents`, remove from root. |
| Diff guardrails (`src/execution/guardrails.ts`: `runGuardrails`, built-in patch checks) | 393 | several | `docs/guardrails.md`, README, ops-pipeline example | Keep, but it shares the word "guardrails" with the input/output guardrails of row 40; rename or split the page. |
| Validators (`src/utils/validators.ts`: `isValidEmail`, `safeValidate`, `validateWithSchema`) | 76 | 3 | none | Remove from root. |

Size of the clear candidates (flows, agent-types, legacyEvents, crypto, StorageService, repository types, Jira, GitHub, Slack/email tools, delegation, validators): about **6,750 lines, 15% of non-test `src/`**, and roughly 80 of the 705 root exports belong to these modules (name-pattern match over `audit2/root-exports.json`, approximate). The root barrel is `export *` over 26 modules (`src/index.ts`), which is why the export count is 705 while docs snippets use 123 of them.

## Things I could not verify

- **Any real model call.** No API key was used. (a) `chat.ts` was type-checked only; (b) and (c) ran with `mockModel`.
- **Docker**: no daemon on this machine, so `SubprocessSandbox`, the Docker deploy target and credential-broker egress were not exercised (their integration tests skip).
- **Agent Forge**: not built here; `lousho studio` from a tarball, the Forge test suites and the real published tarball size (with `apps/agent-forge/dist`) are unmeasured.
- **A clean full test run in one go.** I have one crashed run, one run with 5 lock-timeout files, and a clean re-run of the deploy files. I did not repeat the full suite a third time.
- `npm run test:types`, `test:coverage`, `fallow`, `docs:verify-snippets`, `docs:llms:check`, `pack-smoke`: not run. The tracker's "fallow 0 above threshold" and "171 snippets" claims are unchecked.
- **`ai` 6 with the real package**, and Ollama on `ai` 6/7 with zod 4.
- Slack and Discord channels against the real APIs; ACP against Zed; MCP server against a real client.
- The docs site (`linuxdevil.github.io/agent-sdk-docs`) and the CI badge.
- The tracker's claims that nested sub-agent fingerprints are not compared and that remote sub-agent usage is not added to the lead's totals.
- The competitor columns of the matrix (eve, open-harness): out of scope here.
- The claim that the tree equals `origin/main` `03c45f0`: I worked on HEAD `4ce8a4d` as found and did not compare trees.

## Files in this folder

- `our-report.md` (this file)
- `reference-agents/lousho/{chat.ts,coding.ts,durable-job.ts}`, `tsconfig.json`, `tsconfig.dist.json`, `metrics.cjs`
- `behavior/` (mock-model variants of (b) and (c), with junctions to the worktree under `node_modules/`; remove the junctions with `rmdir`, not a recursive delete)
- `count-exports.cjs`, `root-exports.json`, `docs-imports.cjs`, `sym.sh`, `nontest.txt`
- `pack.json`, `lint.log`, `vitest.log`, `vitest2.log`, `vitest.json`, `vitest-deploy.log`, `vsum.cjs`
- `eve/` and `open-harness/` were already here and are not mine.
