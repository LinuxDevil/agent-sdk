# CLI

Installing the package also installs the `lousho` command. It scaffolds
projects, checks your setup, runs an agent locally, serves it over MCP, runs
evals, shows saved traces, builds a deployable artifact and launches the Agent Forge dashboard.
Run it with `npx lousho <command>` inside a project that has the SDK installed.

| Command | What it does | Details |
| ------- | ------------ | ------- |
| `lousho init [dir]` | Scaffold a project: an agent with an example tool, an offline test, `.env.example`; installs dependencies and runs `git init`. | [Installation](./installation.md#scaffolding-a-new-project) |
| `lousho doctor [spec\|agent-dir\|agent.ts] [--json] [--ping]` | Check Node, peer packages, provider keys, and optionally a spec file, agent directory or agent module (its provider's key is then required); `--ping` also checks each configured provider endpoint answers and accepts the key. Prints a fix for every problem. | [Installation](./installation.md#troubleshooting-lousho-doctor) |
| `lousho dev <path>` | Local dev server for a spec file, an agent directory or a TS agent: chat UI with a session per tab and streamed events, hot reload on save. | [Below](#lousho-dev) |
| `lousho chat <path>` | Terminal REPL for a spec file, an agent directory or a TS agent: streams replies, shows tool calls, asks for approvals and questions. | [Below](#lousho-chat) |
| `lousho acp <path>` | Serve a spec file, an agent directory or a TS agent to an editor (Zed and other ACP clients) over the Agent Client Protocol on stdio. | [ACP](./acp.md) |
| `lousho add <name>` | Install a tool, skill, channel, schedule or memory slot from a JSON registry into an agent directory, after showing its permission manifest and checking the code against it. | [Registry](./registry.md) |
| `lousho mcp <spec>` | Serve the agent as an MCP server (stdio, or HTTP with `--http`). | [MCP](./mcp.md#serve-an-agent-over-mcp) |
| `lousho eval [globs...]` | Run `*.eval.ts` files under vitest; print a summary and write JUnit/JSON reports. | [Evals](./evals.md#lousho-eval) |
| `lousho traces [id]` | List the recent runs saved by `fileTraceExporter()` (duration, model and tool calls, tokens, cost), or print one run as a span tree. | [Observability](./observability.md#local-traces) |
| `lousho build --target=<t> --agent=<spec>` | Build a deployable Node server, Docker image or Cloudflare Worker. | [Deployment](./deployment.md) |
| `lousho studio` | Launch Agent Forge, the visual dashboard, on one local port. | [Agent Forge](./agent-forge.md) |

Every command that takes a `<spec>` reads an agent spec file (`.yaml`,
`.yml` or `.json`, see [Configuration](./configuration.md#agent-spec-files-agentspec)).

## Usage

```text
lousho init [dir] [--provider P] [--template T] [--yes] [--no-install] [--no-git] [--package-manager PM] [--force] [--sdk-path <dir|tgz>]
lousho dev <spec.yaml|spec.json|agent-dir|agent.ts> [--port N] [--host H] [--allowed-hosts a,b] [--no-schedules] [--traces[=dir]]
lousho chat <spec.yaml|spec.json|agent-dir|agent.ts> [--model provider/model] [--session id] [--store sqlite:<file>] [--traces[=dir]]
lousho acp <spec.yaml|spec.json|agent-dir|agent.ts> [--model provider/model]
lousho add <name> [--registry <url-or-path>] [--dir <agent-dir>] [--yes] [--allow <list>] [--overwrite] [--dry-run]    (or --list)
lousho build <agent-dir|spec|agent.ts> --target=<node-server|cloudflare-worker|docker> [--out=<dir>]    (or --agent=<path>)
lousho studio [--port N] [--host H] [--prod|--dev]
lousho mcp <agent.yaml|json|agent-dir|agent.ts> [--http --port N --host H]
lousho doctor [agent.yaml|json|agent-dir|agent.ts] [--json] [--ping]
lousho eval [globs...] [--tag t] [--junit path] [--json path] [--strict] [--judge] [--record | --replay | --drift [--drift-usage]] [--url <base> [--token <bearer>]] [--config vitest.config.ts] [--timeout <ms>]
lousho traces [traceId|prefix] [--dir D] [--limit N] [--json] [--content]
lousho observe <start|status|stop|rebuild-rollups|prune|export|token> [--port N] [--db path] [--host H] [--require-token] [--project X] [--webhook URL] [--retention-days N] [--session-idle-minutes N] [--older-than <N>d] [--since <N>d|<N>h|<N>m] [--agent X] [--out file]
lousho prompt <push <file|->|list|get <name[@version|@label]>|label <name> <label> <version>> [--url U] [--port N] [--token T] [--json] [--name N]
lousho --version
```

Every command parses its flags the same way (Node's `parseArgs`, strict):
`--flag value` and `--flag=value` both work, the last of a repeated flag wins
(`--tag` accumulates), `--` ends the flags, and `-h` / `--help` (or `lousho help
<command>`) prints the command's usage and flags and exits 0. An unknown flag, a flag without its value (it
never takes the next flag as its value) or an extra argument fails with
`LOUSHO_CONFIG_INVALID` and the usage line. A value that starts with `-` needs
the `=` form: `--model=-x`. `--traces` is the one flag whose value is optional:
it takes it only in the `=` form (`--traces=./t`), so `--traces agent.yaml` is
still the flag followed by the path.

**Exit codes.** Every command exits 0 on success, 1 when it ran and failed
(an agent that cannot load, a build error, `lousho eval`'s gate failure, no
matching trace, `lousho add` refusing an item without `--yes`), and 2 for a
usage error: an unknown command, an unknown flag, a missing or invalid
value, an extra argument, or a missing `--target` or agent path. `lousho build` prints where it wrote the build (default
`.lousho/build/<target>`) and the command to run there.

**`.env`.** The commands that run an agent (`dev`, `chat`, `acp`, `mcp`),
`doctor`, `eval` (judge evals need provider keys) and `build` load `./.env` from the working directory when it exists, like
`node --env-file-if-exists=.env`: a variable already set in the environment
wins over the file. A UTF-8 byte order mark at the start of the file (which
PowerShell 5.1's `Set-Content -Encoding utf8` writes) is ignored.

`lousho init` is the exception: it parses its own flags, and a bad flag or
value fails with `InitUsageError` — its message printed as-is, exit code 2 —
not the shared `LOUSHO_CONFIG_INVALID` path. The only short flags besides
`-h` are `-y` for `--yes`, on `init` and on `add`.

`lousho eval` also takes `--config <file>` to run under your own vitest config
instead of the generated one; globs then narrow that config's files as vitest
filters.

`npm create lousho-agent my-agent` runs `lousho init` with the same arguments.
To scaffold against an unreleased build of the SDK, pass `--sdk-path` (see
[Installing from a local build](./installation.md#installing-from-a-local-build)).

## `lousho dev`

```bash
npx lousho dev agent.yaml                  # a spec file
npx lousho dev ./my-agent                  # an agent directory
npx lousho dev src/agent.ts                # a TypeScript (or JavaScript) module
npx lousho dev agent.yaml --port 4000 --host 0.0.0.0
npx lousho dev ./my-agent --no-schedules   # do not fire the directory's cron schedules
```

For an agent directory, `channels/` are mounted under `/channels` and
`schedules/` are started (and both are swapped on reload, the old schedules
stopped first); `--no-schedules` starts none. See
[Agent directories](./agent-directories.md#run-it-with-lousho-dev).

Serves a chat UI on `GET /`, `GET /health`, `GET /dev/status` and the chat
endpoints below (1MB body limit). What `<path>` is follows from the path:

| Path | Loaded with |
| ---- | ----------- |
| `.yaml`, `.yml`, `.json` | `loadSpec()` + `specToAgent()` ([Configuration](./configuration.md)) |
| a directory | `loadAgentDir()` ([Agent directories](./agent-directories.md)) |
| `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs` | the module's default export, or its `agent` export: a `SimpleAgent` (what `createAgent()` returns) or a `createAgent()` options object |

Any other extension, a missing path, or a module with no agent export fails
with a coded error (`LOUSHO_SPEC_UNSUPPORTED_FORMAT`, `LOUSHO_CONFIG_INVALID`)
and its fix. A `.ts` module is imported by the running Node (22.18 or later
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
| `GET /chat/:sessionId` | The session's transcript: `{ sessionId, messages, pending }`; `pending` is `{ status, approvalId? }` while a turn waits on an approval, else `null`. A turn's messages are saved when it finishes, so while it is paused `messages` does not hold that turn yet: use `pending`. |
| `POST /chat/:sessionId/approvals/:id` `{ "approved", "note"? }` or `{ "answer" }` | Decides the pending approval (`agent.approvals.streamResolve()`), or answers a question (`agent.approvals.streamAnswer()`), and streams the continued turn as SSE. It can pause again with another `approval.requested`. `404` when `id` is not pending. When the turn's step paused on several calls, each id is decided on its own; a decision that leaves others pending streams `run.done` with `finishReason: 'awaiting-approval'`, and the last one runs the step. |
| `POST /chat` `{ "message" }` | Deprecated: no session, no streaming. Returns the agent's `ExecutionResult` as JSON, with a `Deprecation: true` header. |

`--traces` (or `--traces=<dir>`) writes every run to local trace files with
`fileTraceExporter()`, in `.lousho/traces` unless you name a directory, so
`npx lousho traces` shows what the agent did. It is off by default because the
files hold prompt, tool argument and tool result content, and the flag prints
the directory it writes to. It applies to spec files, agent directories and
modules alike (a module's own `exporter` is replaced while the flag is set).
See [Local traces](./observability.md#local-traces).

Sessions live in an in-process `memoryStore()` (gone when `lousho dev` stops),
or in the agent's own `store` when a module's `createAgent()` options set one.
The continuation of an approval is streamed too: the endpoint runs it with
`agent.approvals.streamResolve()` (or `streamAnswer()` for a question) and
sends the continued turn's events — the decided tool call, text deltas, a
further pause and `run.done` — as they happen.

`lousho build` servers (`node-server`, `docker`) serve these same endpoints from
the same code, with sessions in a store chosen by `LOUSHO_STORE` and optional
bearer auth: see [Deployment: HTTP API](./deployment.md#http-api).

**Hot reload.** The agent is rebuilt a moment (100 ms) after a file changes,
without restarting the server or dropping the port:

- a spec: the spec file;
- a directory: everything under it (`instructions.md`, the config file,
  `tools/`, `skills/`, `subagents/`), except `node_modules` and `.git`;
- a module: the file and the local files it imports (relative `import` /
  `require` specifiers, found once at startup; no bundler).

Directory and module files are imported with a `?t=<time>` cache-busting query,
so an edited tool or agent file is re-evaluated, and so are the local files it
imports by relative specifier (a shared `./lib/helper.ts`): the query is passed
on to them. Packages under `node_modules` stay cached; restart `lousho dev`
after changing one.
The console logs what reloaded. The new agent is built (and `ready()`, so MCP
servers connect) before it replaces the old one, and the old one is then
`close()`d. If the rebuild fails, the last good agent keeps answering, the error
is logged and shown in a banner on the chat page (and as `error` in
`GET /dev/status`); the next good edit clears it. Sessions survive a reload: the
store outlives the agent swap, so the next message continues the conversation
on the new agent. An approval that was pending on the old agent is not known to
the new one (`404`); start a new session.

Directories and modules are your code and run with your permissions; only run
`lousho dev` on ones you trust.

- `--port` - default `3737`.
- `--host` - default `127.0.0.1` (localhost only). Pass e.g. `--host=0.0.0.0`
  to opt in to LAN access; `lousho dev` has no auth and shows raw provider
  errors, so it then prints a warning.
- `--allowed-hosts a,b` - extra host names the `Host` header may carry. To
  stop DNS rebinding (a web page re-pointing its own domain at your machine),
  every route but `/health` and the channels that `verify` their requests
  answers `403` (`LOUSHO_REQUEST_FORBIDDEN`) unless `Host` is `localhost`, a
  `127.x.x.x` address or `[::1]`; off loopback, IP addresses and the `--host`
  name are accepted too. The list adds to that rule (a tunnel's name, e.g.);
  `*` accepts any host. A channel without `verify` (`httpChannel()` with no
  `verify`) is checked like the dev routes, so reach it through a tunnel only
  with its name in the list.
- POST bodies must be `Content-Type: application/json` (`415` otherwise), and
  a browser POST from another origin is `403`, as on the deployed server
  ([Cross-site requests](./auth.md#cross-site-requests)).

## `lousho chat`

```bash
npx lousho chat agent.yaml                          # a spec file
npx lousho chat ./my-agent --model openai/gpt-4o    # an agent directory, on another model
npx lousho chat src/agent.ts --store sqlite:.lousho/chat.db --session support
```

A terminal REPL: each line you type is one turn of a session. `<path>` is
loaded like `lousho dev` loads it (spec file, agent directory or `.ts`/`.js`
module, see [`lousho dev`](#lousho-dev)); a missing path or bad extension fails
with the same coded error (`LOUSHO_CONFIG_INVALID`,
`LOUSHO_SPEC_UNSUPPORTED_FORMAT`), and so does an invalid `--session` id
(`LOUSHO_SESSION_ID_INVALID`).

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
- Errors from the SDK print with their `[LOUSHO_...]` code and fix, and the
  session continues. A provider failure also names its category and HTTP
  status, e.g. `error: User not found. (auth-failure, HTTP 401)` for a wrong
  API key.
- `--traces` or `--traces=<dir>` writes the session's runs to local trace files,
  as for `lousho dev`; a line on stderr says where.

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
| `--model provider/model` | Use this model instead of the one the target names. Applies to spec files, agent directories and `createAgent()` options exports; a module that exports an already built agent keeps its model. The `vendor/` model prefix chooses the provider; with OpenRouter use `openrouter/<vendor>/<model>` (e.g. `openrouter/openai/gpt-4o`). |
| `--session id` | Open this session (1-128 characters of `A-Za-z0-9_-`); default is a new `chat-<id>`. |
| `--store sqlite:<file>` | Keep sessions in a SQLite file ([`SqliteStore`](./durable-execution.md)), so `--session id` continues a conversation after a restart. Default: in memory. Pending approvals are not restored after a restart. |

The REPL itself is `runChatRepl()` in `src/cli/chatRepl.ts`; it takes the
input lines, an output stream and an agent factory, so it can be tested with
scripted lines and a `mockModel` agent and no terminal.

## `lousho build`

```bash
npx lousho build --target=node-server --agent=agent.yaml        # or docker / cloudflare-worker
npx lousho build ./my-agent --target=node-server                # an agent directory (node-server, docker)
npx lousho build src/agent.ts --target=node-server              # an agent module (node-server, docker)
```

Writes the artifact to `--out` (default `.lousho/build/<target>`) and prints
the command to run or deploy it. Building needs `tsup`
(`npm install --save-dev tsup`). Targets, the HTTP API they serve and the
Workers limits are in [Deployment](./deployment.md).

## `lousho studio`

```bash
npx lousho studio            # prints http://127.0.0.1:4750/?token=<per-launch token>
npx lousho studio --port 5000
```

Starts one local server for the Agent Forge API and UI. Agents and run state
are stored under `.lousho/` in the current directory. See
[Agent Forge](./agent-forge.md) for the walkthrough.

## `lousho observe`

```bash
npx lousho observe start                        # collector on http://127.0.0.1:7777
npx lousho observe status                       # health + fleet counts
npx lousho observe stop                         # <db>.pid + SIGTERM (checks the daemon serves --db)
npx lousho observe rebuild-rollups              # recompute insight aggregates
npx lousho observe prune --older-than 30d       # delete finished runs older than 30 days, then VACUUM
npx lousho observe export --since 7d --out runs.jsonl # traces as JSONL, one per line
npx lousho observe token create --project myapp # bearer key for non-loopback auth
```

Runs the local collector every agent reports to when `LOUSHO_OBSERVE` is
set: traces, fleet monitoring, eval scores, the prompt registry and the
context hub in one SQLite file (default `~/.lousho/observe.db`). Studio's
Traces, Threads, Monitoring and Scores screens read it. `start` takes
`--port` (or `LOUSHO_OBSERVE_PORT`), `--db`, `--host`, `--require-token`
and a repeatable `--webhook` for alert hooks. Each daemon writes its own `<db name>.pid` beside the db
(`observe.db` gives `observe.pid`), so two dbs in one folder never share a
pidfile. `start` exits 1 when the port already serves a different db, and
`stop` refuses to signal when the daemon at the pidfile's port reports another
db or the port answers as a different service, and falls back to signalling
when it cannot verify (unreachable, or an old one-line pidfile). `/health`
tells which db a daemon serves only to callers on the same machine. See
[The observe daemon](./observability.md#the-observe-daemon).

`start --retention-days N` sets how long finished runs are kept (default 30;
`0` keeps everything). Once a day the daemon deletes traces whose
observations all finished more than N days ago. A trace with any run still
open, and a session that is still `active`, is kept whatever its age. Rollups,
prompts and hub entries are never pruned. `prune --older-than <N>d` (whole
days, N >= 1) does the same pass now, prints the observation, score and session
counts it deleted, and then runs `VACUUM` to reclaim disk space (the daily pass
never does). If only the `VACUUM` fails (for example, the db is busy), the
prune stays committed, the error goes to stderr and the exit code is 0. It is
safe to run while the daemon is up. A bad N is a usage
error (exit 2). See [Retention](./observability.md#retention).

`start --session-idle-minutes N` sets when a conversation counts as finished
(default 30; `0` turns it off, so a session stays `active` until its agent goes
down). The daemon's sweep marks a session `ended` once none of its runs is
still open (a run marked `interrupted` does not count) and nothing in it has started or finished for N minutes; its
`ended_at` is the time of that last activity. A new run in an `ended` (or
`interrupted`) session makes it `active` again. Ended sessions are then pruned
by `--retention-days` like any other finished session. A bad N is a usage
error (exit 2). See [Idle sessions](./observability.md#idle-sessions).

`export` writes traces as JSONL: one line per trace, `{ trace, observations,
scores }` (the same rows the trace API returns), oldest first, with no cap on
how many. `--since <N>d` (or `<N>h`, `<N>m`) keeps traces that started within
that window; `--agent X` keeps one agent, matched by `agent_id` or, when no
agent has that id, by its registered name (a name shared by two agents is a
usage error, exit 2). Without `--out` the lines go to stdout and nothing else
does (the count goes to stderr, so a pipe stays clean); `--out file` creates or
overwrites the file and prints the count to stdout. It reads the db directly, so
no daemon needs to be running. See [Export](./observability.md#export).

## `lousho prompt`

```bash
npx lousho prompt push prompt.md --name mira    # publishes a new version
npx lousho prompt list
npx lousho prompt get mira@latest
npx lousho prompt label mira prod 3             # mira@prod -> 3 (was 2)
npx lousho prompt get mira@prod
```

Publishes and reads prompt versions in the observe daemon's registry. Agents
resolve them with `createAgent({ prompt: 'mira@latest' })` (or a label,
`'mira@prod'`) or `LOUSHO_PROMPT`.

- `push` publishes the file (`-` reads stdin) as the next version. A push
  whose text and `--variables` equal the latest version's mints nothing and
  prints `mira@2 is unchanged` (exit 0). `--labels prod,canary` points those
  labels at the resulting version, the new one or the unchanged latest.
- `get <name>[@ref]` prints a version's text; `ref` is an integer, `latest`
  (the default) or a label. `--json` prints the row, whose `labels` are the
  labels currently pointing at that version.
- `label <name> <label> <version>` moves a label: a label points at exactly
  one version, so this takes it off the one that held it, and prints
  `mira@prod -> 3 (was 2)` (or `(was unset)` for a new label). A label is a
  name without whitespace, `@` or `/`, and not `latest` or all digits. See [The observe daemon](./observability.md#the-observe-daemon).
