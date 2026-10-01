# Competitor research: eve (Vercel) and open-harness (MaxGfeller)

Date: 2026-10-01. Method: web search plus fetches of primary sources (GitHub repos, raw docs, vendor blog). Caveat: WebFetch summarises pages through a small model, so code snippets are close paraphrases of the sources, not guaranteed byte-exact. Items marked UNVERIFIED were not found in any source I could read.

## 1. Identification

| Name | Most likely project | Confidence | Evidence |
|---|---|---|---|
| eve | **Vercel eve**, open-source TypeScript agent framework, public beta 2026-06-17, Apache-2.0, ~5.4k stars, `npx eve@latest init` | High | https://vercel.com/blog/introducing-eve , https://github.com/vercel/eve , https://www.infoq.com/news/2026/06/vercel-eve-agents/ |
| open-harness | **MaxGfeller/open-harness** ("OpenHarness"), `@openharness/*` on npm, MIT, ~616 stars, created 2026-02-23, last push 2026-07-17, built on Vercel AI SDK | Medium-high (matches the hint "MaxGfeller/open-harness", "@openharness/*") | https://github.com/MaxGfeller/open-harness , https://open-harness.dev/ , https://docs.open-harness.dev/llms.txt |

Alternatives noted, not covered in depth:
- **HKUDS/OpenHarness** (Python, PyPI `openharness-ai`, CLI `oh`, 43 tools, personal agent "Ohmo"): https://github.com/HKUDS/OpenHarness . Python, so unlikely to be the TypeScript target.
- **Vercel AI SDK "harness layer" / `HarnessAgent`** (adapters for Claude Code, Copilot etc.; `vercel-labs/harness-agent-eve-extension` exposes it as an eve tool): https://vercel.com/kb/guide/sandboxed-coding-agent-with-harnessagent . Related to both, but a different thing.
- `strands-agents/harness-sdk` came up in search for "open-harness"; different product.

## 2. eve (Vercel)

### Core idea
Filesystem-first: "a file's name and place in the tree are its definition." An agent is a directory; discovery wires everything. Built on Vercel's open-source Workflow SDK for durability. Source: blog + https://github.com/vercel/eve .

### Layout (verified from blog/README)
```
agent/
  agent.ts            # defineAgent({ model })
  instructions.md     # system prompt (markdown)
  tools/*.ts          # defineTool
  skills/*.md         # frontmatter + body, loaded on demand
  subagents/<name>/agent.ts
  channels/*.ts       # slack, discord, teams, telegram, twilio, github, linear, HTTP default, custom defineChannel
  schedules/*.ts      # defineSchedule({cron, run})
  connections/*.ts    # defineMcpClientConnection / defineOpenAPIConnection
  memory/<slot>.ts    # defineMemory
evals/*.eval.ts
```
Repo packages (verified listing): `eve`, `eve-code`, `eve-catalog`, `eve-computer-use`, `eve-self-modification`, `eve-buzz-acp-adapter`; also `docs/` (bundled in the npm package), `apps/`, `e2e/`.

### Hello world (two files)
```ts
// agent/agent.ts
import { defineAgent } from "eve";
export default defineAgent({ model: "anthropic/claude-opus-4.8" });
```
plus `agent/instructions.md`. Docs say `agent.ts` can be omitted (default model `openai/gpt-6-luna-fast`, reasoning high, per agent-config doc).
Scaffold: `npx eve@latest init my-agent` creates the project, installs deps, runs git init, and opens a terminal UI; you can send the first message while it loads; model credentials are connected interactively; no Vercel project needed (https://raw.githubusercontent.com/vercel/eve/main/docs/getting-started.mdx).

### Tool
```ts
import { defineTool } from "eve/tools"; import { z } from "zod";
export default defineTool({
  description: "Run read-only SQL queries",
  inputSchema: z.object({ sql: z.string().describe("SELECT only") }),
  needsApproval: ({ toolInput }) => estimateScanGb(toolInput.sql) > 50,
  async execute({ sql }) { /* ... */ },
});
```
`needsApproval` is a predicate on the input; the session pauses with no compute use until approved. Also `defineWorkflowTool`, `defineDurableCallback`, `disableTool`, built-ins (`bash, read_file, write_file, web_fetch, glob, grep, load_skill, ask_question, web_search, sleep, no_reply`), `eve/tools/approval` policies.

### Other abstractions (verified)
- **Subagents**: directory under `subagents/`, own `agent.ts` with `description`; isolated context; `defineRemoteAgent`; `tool: false` hides from parent.
- **Skills**: markdown with `description` frontmatter; `defineSkill`.
- **Memory**: slot files `agent/memory/<slot>.ts` with `provider`, `scope` (e.g. `byPrincipal`), `namespace`, `visibility`. Lifecycle: recall, expose tools, capture. Providers: file memory (bounded doc), Supermemory, Upstash AgentKit, Kybernesis Arcana, custom (memory/overview.mdx).
- **defineAgent fields**: `model`, `reasoning` (provider-default|none|minimal|low|medium|high|xhigh), `compaction.thresholdPercent` (default 0.9), `limits` (maxInputTokensPerSession default 40M, maxOutputTokensPerSession, maxTokenCostUsdPerSession, sessionTimeoutMs default 30 days), `modelOptions`, `experimental.workflow` (world e.g. `@workflow/world-postgres`, `modelCallsPerStep`), `build.externalDependencies` (agent-config.md).
- **Dynamic config**: `defineDynamic({ events: { "session.started": (e, ctx) => ... } })` for model/tools/connections/skills/instructions at runtime. `defineHook` for lifecycle; `defineState` in `eve/context` for session state.
- **Sandbox**: `defineSandbox`; adapters Vercel Sandbox (prod), Docker, microsandbox, just-bash (local). Credentials are brokered by the framework so the model never sees tokens/URLs.
- **Durable execution**: each step checkpointed; survives crashes and deploys; in-flight sessions finish on the version they started.
- **Channels**: one file per surface; sessions route between them; auth helpers `localDev`, `vercelOidc`.
- **Schedules**: cron, deployed as Vercel Cron.
- **Observability**: OpenTelemetry spans per turn/tool/model call; `eve logs`, `eve traces`; `defineInstrumentation`.
- **Evals** (`eve/evals`): `defineEval({ async test(t){ await t.send(..); t.completed(); t.calledTool("run_sql"); t.check(t.reply, includes(..)) } })`; `t.judge()` LLM-as-judge; gate/soft/`atLeast(threshold)`; `mockModel` for deterministic runs; reporters Braintrust/JUnit; same evals run against a deployed URL (`eve eval --url`); `--junit`, `--strict`, `--tag`, concurrency (evals/overview.mdx).
- **Frontend**: `eve/react|vue|svelte` `useEveAgent`; `eve/next|nuxt|sveltekit` plugins; `eve/client`; `eve/server`.
- **Models**: provider strings routed via AI Gateway with fallbacks; `eve/models/{openai,anthropic}`; `chatgpt()` subscription provider; `auto`.
- **CLI** (reference/cli.md): `init, dev (TUI, port 2000, --resume, --no-ui), build, start, info, set model, add (registry items), registry, extension init/build, remote connect/invoke/info, logs, traces, eval, telemetry, link, deploy, acp (Agent Client Protocol)`.
- **Dev UX**: hot reload of instructions/config; TUI shows skill loads, tool calls, sandbox commands in checkpointed steps; structured events over HTTP for curl/CI.
- **Docs**: large tree (concepts, tutorial, guides, patterns, protocols, reference/typescript-api, reference/cli, telemetry, responsible-use). Docs shipped inside the npm package.

### Weaknesses / limits (inference unless stated)
- Strong Vercel gravity: durability, sandbox, cron, gateway, observability UI work best on Vercel (stated in blog). Non-Vercel durable "worlds" are under an `experimental` key (verified field name; maturity is inference).
- Beta; README says APIs may change. 373 open issues / 594 PRs at fetch time (verified).
- Directory convention is magic; embedding an agent in an existing app without the `agent/` tree is less obviously first-class (inference; `eve/server` and `eve/client` exist).
- Docs examples show inconsistent model ids (opus-4.8 vs 5.5), minor polish issue.

## 3. open-harness (MaxGfeller)

### Core idea
Code-first, composable SDK for building Claude-Code/Codex-style harnesses on the Vercel AI SDK. Stateless `Agent`, stateful `Session`, middleware-composable `Conversation`. Sources: README, https://docs.open-harness.dev/llms.txt , llms-full.txt.

### Packages (verified)
`@openharness/core` (Agent, Session, Conversation, middleware, tools, UI stream), `@openharness/provider-chatgpt` (experimental ChatGPT/Codex OAuth), `@openharness/provider-vfs` (in-memory / SQLite / real-FS sandbox), `@openharness/react`, `@openharness/vue` (AI SDK 5 chat UIs). Monorepo: packages, examples, apps.

### Hello world
```ts
const agent = new Agent({
  name: "dev", model: openai("gpt-5.4"),
  tools: { ...createFsTools(new NodeFsProvider()), ...createBashTool(new NodeShellProvider()) },
  maxSteps: 20,
});
for await (const e of agent.run([], "Refactor the auth module"))
  if (e.type === "text.delta") process.stdout.write(e.text);
```
Roughly 10 lines plus imports; history is a plain array you pass in and get back in the `done` event.

### Tool
Plain AI SDK helper: `tool({ description, inputSchema: z.object({...}), execute })`. No bespoke tool abstraction.

### Other abstractions (verified)
- **Permissions**: single `approve({toolName, toolCallId, input}) => Promise<boolean>` callback; denial raises `ToolDeniedError`, surfaced to the model.
- **Middleware**: `apply(toRunner(agent), withTurnTracking(), withCompaction({contextWindow, model}), withRetry({maxRetries}), withPersistence({store, sessionId}))`; `withHooks({onBeforeSend,onAfterResponse,onError})`.
- **Compaction**: two phases: prune old tool results to `"[pruned]"` keeping ~40K recent tokens, then LLM summary; `DefaultCompactionStrategy({protectedTokens, summaryModel})`. Emits `compaction.*` events.
- **Subagents**: auto `task` tool; dynamic `SubagentCatalog {list, resolve}`; `maxSubagentDepth`; resumable sessions with modes stateless/new/resume/fork; background runs with `agent_await/status/cancel`, `maxConcurrent`, timeout.
- **Skills**: `SKILL.md` frontmatter; `skills.paths`; auto `skill` tool. **AGENTS.md/CLAUDE.md**: walked up from cwd and prepended; disable with `instructions:false`.
- **MCP**: stdio / http / sse, lazy connect, `serverName_toolName` namespacing, `agent.close()`.
- **Providers**: `FsProvider` / `ShellProvider` interfaces (Node, VFS; custom for E2B, Cloudflare, Daytona per docs).
- **Events**: text/reasoning delta+done, tool.start/done/error, step.*, turn.*, compaction.*, retry, error, done.
- **UI**: `Conversation.toResponse()` for Next.js; React/Vue `useOpenHarness`, `useSubagentStatus`, `useSessionStatus`, `useTodos`; typed custom data parts `data-oh:*`. Built-in todo tools.
- **Docs**: compact docs site with `llms.txt` and `llms-full.txt`.

### Gaps (verified absence in docs read, or inference)
- No testing utilities documented (llms-full.txt has none): verified absence in the fetched text.
- No CLI/scaffolder, durable execution, evals, tracing/OTel, scheduling/triggers, sandbox beyond provider interfaces: none found in docs read. UNVERIFIED for the source tree (source not read).
- Likely single maintainer (inference); 616 stars; 2 open issues.

## 4. Feature matrix

Legend: Y yes, N not found, P partial. "N" for open-harness means not found in README/docs, not proven absent from source.

| Capability | eve | open-harness | Source |
|---|---|---|---|
| Hello world size | Y 2 files | Y ~10 lines | blog; README |
| Scaffolding CLI | Y `eve init` | N | reference/cli.md |
| Dev server / TUI / hot reload | Y | N | getting-started.mdx |
| Tool definition | Y `defineTool` (zod) | Y AI SDK `tool()` | blog; llms-full |
| Per-call approval | Y predicate `needsApproval`, durable pause | P global `approve` callback | blog; llms-full |
| Subagents | Y dir-based, remote agents | Y task tool, catalogs, background, resume/fork | blog; llms-full |
| Skills | Y md | Y SKILL.md | both |
| AGENTS.md loading | UNVERIFIED | Y | llms-full |
| Cross-session memory | Y slotted providers | P (session store only) | memory/overview.mdx |
| Context compaction | Y threshold config (algorithm UNVERIFIED) | Y two-phase prune+summarize, events | agent-config.md; llms-full |
| Hooks/middleware | Y `defineHook`, `defineDynamic` | Y middleware stack + 3 hooks | reference/typescript-api.md; llms-full |
| Sandboxing | Y `defineSandbox` (Vercel/Docker/microsandbox/just-bash) | P Fs/Shell provider interfaces, VFS | blog; llms-full |
| MCP | Y + OpenAPI connections | Y stdio/http/sse | both |
| Credential brokering | Y | N | blog |
| Streaming / events | Y HTTP structured events | Y typed events, AI SDK 5 streams | both |
| Frontend hooks | Y react/vue/svelte + framework plugins | Y react/vue | typescript-api.md; README |
| Providers / model routing | Y gateway strings + fallbacks | Y any AI SDK provider | blog; README |
| Budgets/limits | Y tokens/USD/time per session | P maxSteps only | agent-config.md |
| Durable execution / resume | Y (Workflow SDK) | P persistence middleware, no durable exec | blog; llms-full |
| Triggers / schedules | Y cron + channels | N | blog |
| Chat channels | Y Slack/Discord/Teams/Telegram/Twilio/GitHub/Linear | N | blog |
| Evals | Y `defineEval`, judge, gates, reporters, remote | N | evals/overview.mdx |
| Test utilities / mock model | Y `mockModel` | N | evals/overview.mdx; llms-full |
| Tracing / OTel | Y spans + `eve traces` | N | blog; cli.md |
| Deployment | Y `eve deploy` (Vercel-centric) | N | blog |
| Registry / extensions | Y `eve add`, `extension init` | N | cli.md |
| ACP | Y `eve acp` | N | cli.md |
| llms.txt docs | P docs bundled in npm | Y llms.txt/llms-full.txt | repo; docs site |
| License | Apache-2.0 | MIT | repos |

## 5. Ideas to adopt or beat

1. **Zero-config hello world and `init`.** eve: two files; open-harness: ~10 lines. Better: `npm create` scaffold plus a documented 5-line in-code agent (default provider from env), runnable via `loushy dev` with no extra file. Publish "lines/seconds to first reply".
2. **Support both authoring modes.** eve is directory-only; open-harness is code-only. Better: a typed code API as the source of truth, plus an optional filesystem loader (agents/, tools/, skills/) compiling to the same objects.
3. **Dev loop.** `loushy dev` with hot reload plus terminal/Studio UI showing steps, tool calls, approvals, token cost, checkpoints. Beat eve by making Agent Forge the same UI with time-travel from checkpoints and "edit prompt and replay from step N".
4. **Input-aware approvals that pause durably** (eve `needsApproval(input)`), with open-harness's simple `approve` callback as the minimal form. Better: declarative policies (allow/deny/ask by tool, arg glob, cost estimate), an audit log, and approval via any trigger (Slack, HTTP, CLI).
5. **First-class budgets.** eve `limits` covers tokens, USD, wall time. Better: per-agent, per-tool and per-flow budgets, a typed `BudgetExceeded` event, graceful degrade to a cheaper model.
6. **Built-in eval framework with mock model.** eve has it; open-harness lacks it. Better: `loushy eval` with trajectory assertions, LLM judge, tool-trace snapshots, record/replay of provider calls for deterministic CI, JUnit output, remote-target runs. Ship a testing package (mock provider, fake clock, in-memory checkpoint store).
7. **Observable, pluggable compaction.** open-harness: prune then summarize with events; eve: threshold only. Better: pluggable strategies, before/after token counts in events, pinned messages, dry-run preview in the dev UI. Extend your Factor 9 work.
8. **Scoped memory slots.** eve's provider/scope split is the best pattern seen. Better: file, SQLite and vector providers in core behind one interface, plus a memory inspector in Agent Forge.
9. **Sandbox and credential brokering.** Model never sees tokens in eve. Better: a `Sandbox` interface with local (Docker/just-bash) and Cloudflare adapters, egress allowlist, secret-injection proxy, documented as a security guarantee.
10. **Host-agnostic durable resume.** eve's durability is Vercel/Workflow-centric (non-Vercel is `experimental`). Your checkpoint stores (Node, Cloudflare Worker) are a differentiator: make resume a documented one-liner on Node, Workers and Postgres, and let in-flight runs finish on the version they started.
11. **Typed event stream plus UI hooks.** Both ship React/Vue; eve adds Svelte and framework plugins. Better: one versioned, documented event schema, hooks for React/Vue/Svelte, and an AI SDK UI-stream adapter to avoid lock-in.
12. **Docs as product, agent-readable.** open-harness ships llms.txt/llms-full.txt; eve bundles docs in the npm package. Do both, auto-load AGENTS.md/CLAUDE.md, and CI-check one runnable example per docs page.
13. **Error messages and type inference.** Neither documents this strongly (UNVERIFIED for both). Infer tool input types from the schema in `execute`, validate config with "did you mean" messages plus a doc URL per error code, add `loushy doctor`.
14. **Registry/extensions.** eve has `eve add` and extension packages. Better: `loushy add <tool|skill|trigger>` from a registry that shows permission manifests before install.
15. **Interop protocols.** eve exposes ACP. Add ACP and MCP-server export (agent as an MCP tool) so Loushy agents are reachable from editors and other agents.

## 6. Verified vs inferred
- Verified from sources: identities, licenses, star counts at fetch time, eve file layout/APIs/CLI/evals/memory/limits, open-harness APIs, middleware, compaction, subagents, MCP, events, packages.
- Inferred: weaknesses, portability claims, single-maintainer status, absence of features not mentioned in the docs read, error-message quality.
- Not obtained: eve approval/sandbox/dynamic-config deep pages (guessed paths returned 404), source-code reading of either repo, open-harness testing story beyond docs.

## Sources
- https://vercel.com/blog/introducing-eve
- https://vercel.com/changelog/introducing-eve-an-open-source-agent-framework
- https://www.infoq.com/news/2026/06/vercel-eve-agents/
- https://github.com/vercel/eve (docs: agent-config.md, getting-started.mdx, reference/cli.md, reference/typescript-api.md, memory/overview.mdx, evals/overview.mdx)
- https://github.com/MaxGfeller/open-harness , https://open-harness.dev/ , https://docs.open-harness.dev/llms.txt , https://docs.open-harness.dev/llms-full.txt
- https://github.com/HKUDS/OpenHarness
