# Agent Forge

Agent Forge (`apps/agent-forge`) is this SDK's companion visual dashboard:
build an agent's graph on a canvas, run it, watch it execute in a live
debug console, chat with it, and author sandboxed pre/post hooks - all
reading and writing the exact same `AgentSpec` YAML that `loushy dev` and
`loushy build` use. It's launched with one command, `loushy studio`, and
ships as part of this SDK's npm package (LOU-S).

This doc covers: installation, the `loushy studio` quickstart, a
first-agent walkthrough, hook authoring, time travel (replaying a run from
a past step), and how settings/secrets/deploy wiring works (and doesn't
yet).

## Installation

Agent Forge ships inside `@loushy/build-ai-agent` itself - there's no
separate package to install:

```bash
npm install @loushy/build-ai-agent
```

That's it. `loushy studio` (below) runs a pre-built copy of the app; you
don't need `apps/agent-forge`'s own source or its devDependencies (Vite,
`tsx`, etc.) to use it.

If you're working inside this SDK's own monorepo instead (contributing to
Agent Forge itself), see [Dev mode](#dev-mode) below.

## Quickstart

```bash
npx loushy studio
```

This starts one local server and prints its URL (default
`http://127.0.0.1:4750`). Open it in a browser - you'll see the canvas,
the left rail (your saved agents + a node/hook palette), the Inspector
(right), and a bottom drawer with Chat/Logs/Trace/Output/Settings tabs.

Useful flags:

```bash
npx loushy studio --port 5000       # pick a different port
npx loushy studio --host 0.0.0.0    # bind to all interfaces
npx loushy studio --prod            # force production mode (see below)
npx loushy studio --dev             # force dev mode (monorepo only)
```

Agent specs and run state are stored under `.loushy/` in the directory you
ran `loushy studio` from (agent YAML files under `.loushy/agents/`,
checkpoints and approvals alongside them) - the same `.loushy/` layout
`loushy dev`/`loushy build` use.

### Production vs. dev mode

`loushy studio` has two modes, and picks the right one automatically:

- **Production** (the default once Agent Forge has been built): a single
  Express server serves both the REST/WebSocket API *and* the pre-built
  client (React app) as static files, on one port. This is what runs when
  you `npm install` the published package - there's no separate Vite dev
  server and no TypeScript loader involved.
- **Dev** (falls back to this if the build hasn't been run yet, i.e. inside
  a source checkout of this monorepo): the API server runs straight off
  its TypeScript source via `tsx`, alongside a real Vite dev server (with
  hot-module reload) that proxies API requests to it. Two processes, two
  ports internally, one command.

`--prod`/`--dev` force one or the other; run without either flag and
`loushy studio` auto-detects based on whether `apps/agent-forge/dist-server`
exists.

## First-agent walkthrough

1. **Create an agent.** In the left rail's "Agents" tab, click **New**,
   give it a name, and pick a starting template - **Blank graph** (a single
   LLM node using the built-in `mock` provider) is the fastest way to try
   things out without any API keys. Agent Forge creates the agent and opens
   it on the canvas.
2. **Look at the graph.** A blank agent is one `llm` node. Drag more nodes
   in from the left rail's palette (**Trigger**, **LLM step**, **Tool
   call**, **Approval gate**, **Response / output**) and connect them by
   dragging between their handles. Click a node to edit its settings
   (prompt, provider/model, tools, breakpoints) in the Inspector on the
   right.
3. **Run it.** Click **Run** in the top bar. With the `mock` provider
   there's nothing to configure - it returns deterministic canned output,
   which is exactly the point for trying the rest of the UI without needing
   a real LLM API key. The status pill in the top bar tracks the run
   (`running` → `idle`/`error`/`awaiting approval`).
4. **Watch it in the debug console.** Open the bottom drawer's **Logs**
   tab for a live, filterable log feed of the run (trigger/llm/tool/
   sandbox/checkpoint/approval events), or **Trace** for a span waterfall.
   Turn on **Debug** in the top bar (or set a breakpoint on a node in the
   Inspector) to pause the run at LLM/tool boundaries and step through it
   with the debug bar's **Step**/**Continue** controls; expand "Live
   message array" there to inspect the in-flight message list. **Output**
   shows the full `ExecutionResult` (messages, tool calls, usage, steps) as
   a collapsible JSON tree once the run finishes or pauses.
5. **Chat with it.** The **Chat** tab is a separate conversational
   transport (`POST /agents/:id/message`, streamed back over the same
   WebSocket as everything else) - send it a message and it replies in the
   thread, independent of the graph "Run" button above. Each agent keeps
   its own chat history (`+ New chat` starts a fresh session; old ones stay
   browsable).
6. **Approve a paused tool call.** Add a **Tool call** node, open it in the
   Inspector, and pick a tool - some tools (or an agent's own policy) can
   require human approval before running. When a run or chat hits one, an
   inline approval card appears (in the top bar for a graph run, or as a
   message bubble in the Chat thread) showing the tool name and its
   arguments. Click **Approve** to let it proceed or **Reject** to abort
   that call; the run resumes automatically either way.

## Hooks

Hooks (LOU-Q) are small, sandboxed functions that run immediately before or
after a tool call or an LLM `generate` - the same mechanism the SDK core
exposes as `HookRegistry`/`AgentHook` (see
[API Overview](./api-overview.md)), but authored visually and attached to a
specific canvas node.

To attach one:

1. Select an `llm` or `tool` node on the canvas (hooks only apply to these -
   they're the two points `AgentExecutor` actually calls out to).
2. Open the Inspector's **Hooks** section. Drag a **Pre-hook** or
   **Post-hook** entry from the left rail's palette onto the node (or drop
   it directly in the Hooks section) to attach a new one; you'll get a
   choice of starter templates (`redact-pii`, `rate-limit`, `audit-log`,
   `inject-context`) as an editable starting point.
3. Click the hook's chip to select it, then edit its code in the CodeMirror
   editor. The code is the **body** of an async function invoked as
   `hook(ctx)` inside a sandboxed subprocess (`server/hookSandbox.ts`) -
   never in the browser or the API server process itself:
   - For a tool-call hook, `ctx` is `{ toolName, args, result?, error? }`.
     A pre-hook can mutate `ctx.args`; a post-hook can inspect/mutate
     `ctx.result`/`ctx.error`. Return `ctx`.
   - For an LLM-generate hook, `ctx` is `{ messages, model }`. Mutate/push
     onto `ctx.messages` and return `ctx`.
   - **Throwing aborts the step** - a rate-limit hook, for example, throws
     to block the tool call outright rather than letting it run.
4. Toggle the switch on a hook's chip to enable/disable it without removing
   it, or use its **x** to remove it entirely. Only enabled hooks are
   compiled into the run.

Example: a redact-PII pre-hook on a tool node (this is the `redact-pii`
starter template) -

```js
const PII = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
for (const key of Object.keys(ctx.args || {})) {
  if (typeof ctx.args[key] === 'string') {
    ctx.args[key] = ctx.args[key].replace(PII, '[REDACTED]');
  }
}
return ctx;
```

Saving the agent persists these as `spec.policy.hooks` in the agent's YAML;
the server compiles enabled hooks into a real `HookRegistry` for the run
(`server/compileHooks.ts`), routed through the same `SandboxAdapter` a
sandboxed tool uses.

## Time travel

Agent Forge keeps every run's checkpoints, not just the latest: its file
store (`server/checkpointStore.ts`) keeps the same bounded history as the
SDK's `LocalStorageCheckpointStore` (the newest 50 saves per run, under
`.loushy/agents/<id>/checkpoint-history/`; see
[Checkpoint history](./durable-execution.md#checkpoint-history)). From
that history you can fork a run at any step, change what happened there,
and replay it next to the original, with
[`AgentExecutor.fork()`](./durable-execution.md#fork-and-replay) and
`compareTrajectories()` doing the work.

### The History tab

1. Run the agent (Topbar **Run**, or a Chat message).
2. Open the bottom drawer's **History** tab. It lists the run's steps:
   step number, status, the model's finish reason, the tool calls made,
   and the tokens and cost of the step's model call when known.
3. Click **Edit and replay from here** on a step. Choose **Append a user
   message** and type one, or pick one of the step's tool calls to edit
   its result (prefilled with the recorded result; text that parses as
   JSON is sent as JSON).
4. Click **Fork and replay**. The run is forked at that step with your
   edit and started as a new run, `<id>.fork-<n>`.
5. The fork opens next to the original as a side-by-side trajectory: each
   model turn of both runs (text, tool calls and results), the first turn
   where they differ highlighted as **diverged**, and the drift entries
   (tool order, arguments, step count, finish reason) listed below. It
   refreshes when the fork finishes.

### Routes

A run id is the run's checkpoint session id: the agent id for the agent's
own runs, `<id>.fork-<n>` for a fork of run `<id>`. The runtime control
server has three routes for it (the History tab uses them):

| Route | What it does |
| --- | --- |
| `GET /runs/:id/history` | `{ runId, steps }`: one entry per step of the run's latest execution (the newest checkpoint saved at that step), oldest first, with `status`, `savedAt`, `finishReason`, `toolCalls` (`{ id, name, args, result? }`), and `tokens` / `costUsd` of the step's model call when known. 404 when the run has no checkpoints. |
| `POST /runs/:id/fork` | Body `{ fromStep, patch? }`, where `patch` is `{ toolResult?: { toolCallId, result }, appendInput?, businessState? }`. Forks the run at `fromStep`, then starts the fork through the run registry with the original run's spec. Returns 202 `{ runId, fromStep, status }`; the fork streams on `WS /agents/<runId>/stream` and reports on `GET /agents/<runId>/status` like any run. 400 for a bad body or an unknown `toolCallId`, 404 for an unknown run or a step with no checkpoint. |
| `GET /runs/compare?a=&b=` | `compareTrajectories(a, b)` of two runs' latest checkpoints: each run's model turns, `divergedAt` (the first turn that differs) and the `drift` entries. 404 when either run has no checkpoint. |

The flow, for an agent `weather` that has run once:

```bash
curl localhost:4750/runs/weather/history
# {"runId":"weather","steps":[{"step":1,"status":"finished","finishReason":"stop","toolCalls":[],"tokens":...}]}

curl -X POST localhost:4750/runs/weather/fork -H 'content-type: application/json' \
  -d '{"fromStep":1,"patch":{"appendInput":"And in Celsius?"}}'
# {"runId":"weather.fork-1","fromStep":1,"status":{"status":"running",...}}

curl 'localhost:4750/runs/compare?a=weather&b=weather.fork-1'
# {"a":[...],"b":[...],"divergedAt":2,"drift":[{"field":"steps","committed":"1","current":"2"}]}
```

The fork is a run of its own: the original run's checkpoints, status and
chat are unchanged.

## Settings, secrets and deploy wiring

The bottom drawer has a **Settings** tab, but provider API keys, secrets and
deploy-target wiring are a separate, later piece of work (tracked as
LOU-R) and aren't implemented in the UI yet as of this doc - the tab
currently just says so. Until then, configure providers the same way
`loushy dev`/`loushy build` do: via environment variables (see
[Configuration](./configuration.md)), or by using the `mock` provider for
anything you just want to try out inside Agent Forge without credentials.

## Dev mode

If you're working inside this SDK's own monorepo (contributing to Agent
Forge itself, not just using it), `loushy studio` falls back to dev mode
automatically as long as `apps/agent-forge/dist-server` hasn't been built
yet:

```bash
git clone https://github.com/LinuxDevil/agent-sdk.git
cd agent-sdk
npm install
npx loushy studio --dev   # or just `npx loushy studio` before building
```

This runs the API server straight from TypeScript (`tsx`) and a real Vite
dev server with hot-module reload for `apps/agent-forge/src/**`, as two
sibling processes. To build the production bundle used by everyone else
(and to verify what actually ships):

```bash
npm run build:studio   # builds apps/agent-forge/dist (client) and
                        # apps/agent-forge/dist-server (bundled server)
npx loushy studio       # now runs in production mode
```

`npm run build:studio` also runs automatically as part of the root
`prepublishOnly` script, so a published `npm publish` can never ship a
stale or unbuilt studio.

## E2E smoke test

`apps/agent-forge/e2e/studio.spec.ts` is a headless Playwright test that
drives the real, built `loushy studio` (the same `dist-server/index.cjs`
production server, not a dev-mode Vite server) through a browser: it
creates an agent from the "Support bot" template, retargets its tool node
at a server-local `demo-approval` tool (always `needsApproval: true` -
see `server/buildAgent.ts`'s doc comment for why this exists, since none
of the SDK's spec-resolvable built-in tools require approval), sends it a
chat message that triggers the mock provider's tool-call heuristic, waits
for the run to pause on the approval gate, approves it via the Chat tab's
inline approval card, and asserts the run completes. Run it with:

```bash
npm run test:e2e:studio   # from the repo root, or apps/agent-forge/
```

This builds Agent Forge first (`build:studio`), then runs Playwright
against it.

