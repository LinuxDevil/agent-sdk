# CLI

Installing the package also installs the `loushy` command. It scaffolds
projects, checks your setup, runs an agent locally, serves it over MCP, runs
evals, builds a deployable artifact and launches the Agent Forge dashboard.
Run it with `npx loushy <command>` inside a project that has the SDK installed.

| Command | What it does | Details |
| ------- | ------------ | ------- |
| `loushy init [dir]` | Scaffold a project: an agent with an example tool, an offline test, `.env.example`; installs dependencies and runs `git init`. | [Installation](./installation.md#scaffolding-a-new-project) |
| `loushy doctor [spec] [--json]` | Check Node, peer packages, provider keys, and optionally a spec file; prints a fix for every problem. | [Installation](./installation.md#troubleshooting-loushy-doctor) |
| `loushy dev <path>` | Local dev server for a spec file, an agent directory or a TS agent: chat UI with a session per tab and streamed events, hot reload on save. | [Below](#loushy-dev) |
| `loushy chat <path>` | Terminal REPL for a spec file, an agent directory or a TS agent: streams replies, shows tool calls, asks for approvals and questions. | [Below](#loushy-chat) |
| `loushy mcp <spec>` | Serve the agent as an MCP server (stdio, or HTTP with `--http`). | [Configuration](./configuration.md#serve-an-agent-over-mcp) |
| `loushy eval [globs...]` | Run `*.eval.ts` files under vitest; print a summary and write JUnit/JSON reports. | [Evals](./evals.md#loushy-eval) |
| `loushy build --target=<t> --agent=<spec>` | Build a deployable Node server, Docker image or Cloudflare Worker. | [Deployment](./deployment.md) |
| `loushy studio` | Launch Agent Forge, the visual dashboard, on one local port. | [Agent Forge](./agent-forge.md) |

Every command that takes a `<spec>` reads an agent spec file (`.yaml`,
`.yml` or `.json`, see [Configuration](./configuration.md#agent-spec-files-agentspec)).

## Usage

```text
loushy init [dir] [--provider P] [--template T] [--yes] [--no-install] [--no-git] [--package-manager PM] [--force]
loushy dev <spec.yaml|spec.json|agent-dir|agent.ts> [--port N] [--host H] [--no-schedules]
loushy chat <spec.yaml|spec.json|agent-dir|agent.ts> [--model provider/model] [--session id] [--store sqlite:<file>]
loushy build <agent-dir|spec> --target=<name> [--out=<dir>]    (or --agent=<path>)
loushy studio [--port N] [--host H] [--prod|--dev]
loushy mcp <agent.yaml|json> [--http --port N --host H]
loushy doctor [agent.yaml|json] [--json]
loushy eval [globs...] [--tag t] [--junit path] [--json path] [--strict] [--judge] [--record | --replay | --drift [--drift-usage]] [--url <base> [--token <bearer>]]
```

Every command parses its flags the same way (Node's `parseArgs`, strict):
`--flag value` and `--flag=value` both work, the last of a repeated flag wins
(`--tag` accumulates), `--` ends the flags, and `-h` / `--help` prints the
command's usage and exits 0. An unknown flag, a flag without its value (it
never takes the next flag as its value) or an extra argument fails with
`LOUSHY_CONFIG_INVALID` and the usage line. A value that starts with `-` needs
the `=` form: `--model=-x`.

`npm create loushy-agent my-agent` runs `loushy init` with the same arguments.
While the package is not on npm, scaffold from a checkout of this repository
with `node bin/loushy.js init my-agent --sdk-path .` (see
[Installing from a local build](./installation.md#installing-from-a-local-build)).

## `loushy dev`

```bash
npx loushy dev agent.yaml                  # a spec file
npx loushy dev ./my-agent                  # an agent directory
npx loushy dev src/agent.ts                # a TypeScript (or JavaScript) module
npx loushy dev agent.yaml --port 4000 --host 0.0.0.0
npx loushy dev ./my-agent --no-schedules   # do not fire the directory's cron schedules
```

For an agent directory, `channels/` are mounted under `/channels` and
`schedules/` are started (and both are swapped on reload, the old schedules
stopped first); `--no-schedules` starts none. See
[Agent directories](./agent-directories.md#run-it-with-loushy-dev).

Serves a chat UI on `GET /`, `GET /health`, `GET /dev/status` and the chat
endpoints below (1MB body limit). What `<path>` is follows from the path:

| Path | Loaded with |
| ---- | ----------- |
| `.yaml`, `.yml`, `.json` | `loadSpec()` + `specToAgent()` ([Configuration](./configuration.md)) |
| a directory | `loadAgentDir()` ([Agent directories](./agent-directories.md)) |
| `.ts`, `.mts`, `.js`, `.mjs`, `.cjs` | the module's default export, or its `agent` export: a `SimpleAgent` (what `createAgent()` returns) or a `createAgent()` options object |

Any other extension, a missing path, or a module with no agent export fails
with a coded error (`LOUSHY_SPEC_UNSUPPORTED_FORMAT`, `LOUSHY_CONFIG_INVALID`)
and its fix. A `.ts` module is imported by the running Node (22.19 or later
strips types, so relative imports need their file extension); use `.js` for
code that needs a transpiler.

**Chat sessions.** The chat UI keeps one session per browser tab (its id is in
`sessionStorage`; "New session" starts another) and shows the streamed turn:
text as it arrives, tool calls with their arguments and results, errors, and
tokens and cost from `run.done`. A tool call that needs approval shows
Approve / Reject buttons; an `ask_question` call shows its options as buttons
plus a free-text field. The same endpoints work from `curl` or your own page:

| Endpoint | What it does |
| -------- | ------------ |
| `POST /chat` `{ "sessionId", "input" }` | Runs `agent.session({ id: sessionId }).stream(input)` and streams the turn as SSE: one `data: <AgentEvent JSON>` per event ([Streaming](./streaming.md)), then `event: done`. History is kept per `sessionId` (1-128 characters of `A-Za-z0-9_-`). |
| `GET /chat/:sessionId` | The session's transcript: `{ sessionId, messages, pending }`; `pending` is `{ status, approvalId? }` while a turn waits on an approval, else `null`. |
| `POST /chat/:sessionId/approvals/:id` `{ "approved", "note"? }` or `{ "answer" }` | Decides the pending approval (`agent.approvals.resolve()`), or answers a question (`agent.approvals.answer()`), and streams the continued turn as SSE. It can pause again with another `approval.requested`. `404` when `id` is not pending. |
| `POST /chat` `{ "message" }` | Deprecated: no session, no streaming. Returns the agent's `ExecutionResult` as JSON, with a `Deprecation: true` header. |

Sessions live in an in-process `memoryStore()` (gone when `loushy dev` stops),
or in the agent's own `store` when a module's `createAgent()` options set one.
The continuation of an approval is not streamed token by token: the endpoint
runs it with `agent.approvals.resolve()` and sends the turn's tool results and
text as events once it finishes.

`loushy build` servers (`node-server`, `docker`) serve these same endpoints from
the same code, with sessions in a store chosen by `LOUSHY_STORE` and optional
bearer auth: see [Deployment: HTTP API](./deployment.md#http-api).

**Hot reload.** The agent is rebuilt a moment (100 ms) after a file changes,
without restarting the server or dropping the port:

- a spec: the spec file;
- a directory: everything under it (`instructions.md`, the config file,
  `tools/`, `skills/`, `subagents/`), except `node_modules` and `.git`;
- a module: the file and the local files it imports (relative `import` /
  `require` specifiers, found once at startup; no bundler).

Directory and module files are imported with a `?t=<time>` cache-busting query,
so an edited tool or agent file is re-evaluated. A file *imported by* that file
(a shared helper) stays cached by Node: restart `loushy dev` after editing one.
The console logs what reloaded. The new agent is built (and `ready()`, so MCP
servers connect) before it replaces the old one, and the old one is then
`close()`d. If the rebuild fails, the last good agent keeps answering, the error
is logged and shown in a banner on the chat page (and as `error` in
`GET /dev/status`); the next good edit clears it. Sessions survive a reload: the
store outlives the agent swap, so the next message continues the conversation
on the new agent. An approval that was pending on the old agent is not known to
the new one (`404`); start a new session.

Directories and modules are your code and run with your permissions; only run
`loushy dev` on ones you trust.

- `--port` - default `3737`.
- `--host` - default `127.0.0.1` (localhost only). Pass e.g. `--host=0.0.0.0`
  to opt in to LAN access.

## `loushy chat`

```bash
npx loushy chat agent.yaml                          # a spec file
npx loushy chat ./my-agent --model openai/gpt-4o    # an agent directory, on another model
npx loushy chat src/agent.ts --store sqlite:.loushy/chat.db --session support
```

A terminal REPL: each line you type is one turn of a session. `<path>` is
loaded like `loushy dev` loads it (spec file, agent directory or `.ts`/`.js`
module, see [`loushy dev`](#loushy-dev)); a missing path or bad extension fails
with the same coded error (`LOUSHY_CONFIG_INVALID`,
`LOUSHY_SPEC_UNSUPPORTED_FORMAT`), and so does an invalid `--session` id
(`LOUSHY_SESSION_ID_INVALID`).

```text
> look up cats
[lookup] {"q":"cats"}
  -> found cats
Cats are great.
[usage] 20 in / 6 out tokens, $0.0004
> email the report to sam
Approve send_email({"to":"sam@example.com"})? [y/N] y
  -> sent
Done, the report is on its way.
```

- Text is written as the model produces it. Each tool call is one dim line,
  `[tool_name] {args}`, followed by `  -> result` (or `  -> error: ...`).
- A tool call that needs approval asks `Approve <tool>(args)? [y/N]`: `y` or
  `yes` runs it, anything else rejects it and the model carries on. An
  `ask_question` call (`askQuestion: true`) prints the question with numbered
  options; answer with the number or with free text.
- After each turn `[usage]` shows the tokens and, when every model used has
  known pricing, the cost (`~` marks estimated tokens).
- Errors from the SDK print with their `[LOUSHY_...]` code and fix, and the
  session continues.

| Command | What it does |
| ------- | ------------ |
| `/new` | Start a new session (the old one is kept in the store). |
| `/model <provider/model>` | Rebuild the agent on another model; the session continues. A failure keeps the current model. |
| `/compact` | Compact the session's transcript now (old tool results are pruned) and print the before/after size. |
| `/clear` | Empty the session's transcript; the session id stays. |
| `/history` | Print the session's transcript. |
| `/quit` | Leave (Ctrl-D works too). |

| Option | Meaning |
| ------ | ------- |
| `--model provider/model` | Use this model instead of the one the target names. Applies to spec files, agent directories and `createAgent()` options exports; a module that exports an already built agent keeps its model. |
| `--session id` | Open this session (1-128 characters of `A-Za-z0-9_-`); default is a new `chat-<id>`. |
| `--store sqlite:<file>` | Keep sessions in a SQLite file ([`SqliteStore`](./durable-execution.md)), so `--session id` continues a conversation after a restart. Default: in memory. Pending approvals are not restored after a restart. |

The REPL itself is `runChatRepl()` in `src/cli/chatRepl.ts`; it takes the
input lines, an output stream and an agent factory, so it can be tested with
scripted lines and a `mockModel` agent and no terminal.

## `loushy build`

```bash
npx loushy build --target=node-server --agent=agent.yaml        # or docker / cloudflare-worker
npx loushy build ./my-agent --target=node-server                # an agent directory (node-server, docker)
```

Writes the artifact to `--out` (default `.loushy/build/<target>`) and prints
the command to run or deploy it. Building needs `tsup`
(`npm install --save-dev tsup`). Targets, the HTTP API they serve and the
Workers limits are in [Deployment](./deployment.md).

## `loushy studio`

```bash
npx loushy studio            # http://127.0.0.1:4750
npx loushy studio --port 5000
```

Starts one local server for the Agent Forge API and UI. Agents and run state
are stored under `.loushy/` in the current directory. See
[Agent Forge](./agent-forge.md) for the walkthrough.
