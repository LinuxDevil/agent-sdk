# CLI

Installing the package also installs the `@linuxdevil/lousho` command. It scaffolds
projects, checks your setup, runs an agent locally, serves it over MCP, runs
evals, shows saved traces, builds a deployable artifact and launches the Agent Forge dashboard.
Run it with `npx @linuxdevil/lousho <command>` inside a project that has the SDK installed.

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
| `lousho improve <path> --check <module>` | Experimental. Run one self-healing cycle on an agent directory: propose edits to its instructions and skills from failed runs in your local observe database, gate them, replay them on fresh runs, and apply (auto mode, the default) or queue (manual mode) one that passes. `--watch` keeps it running; `pause`, `status`, `rollback`, `approve` and the other subcommands manage it. `--dry-run` prints the review card and applies nothing. | [Below](#lousho-improve) |

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
lousho observe <start|status|stop|rebuild-rollups|prune|export|failures|token> [--port N] [--db path] [--host H] [--require-token] [--project X] [--webhook URL] [--retention-days N] [--session-idle-minutes N] [--older-than <N>d] [--since <N>d|<N>h|<N>m] [--agent X] [--out file]
lousho prompt <push <file|->|list|get <name[@version|@label]>|label <name> <label> <version>> [--url U] [--port N] [--token T] [--json] [--name N] [--labels a,b] [--variables x,y]
lousho improve <agent-dir|agent.ts> --check <module> [--model provider/model] [--editor provider/model] [--db path] [--since <N>d|<N>h|<N>m] [--agent X] [--protect traceId]... [--read-only tool]... [--max-tokens n] [--out file] [--with-recoveries] [--approval auto|manual] [--proposers 1-4] [--mode agg|seq] [--select] [--no-parallel-editors] [--dry-run] [--watch [--interval 15m]]
lousho improve <revisions|rollback|audit|pending|approve|reject|pause|resume|status> <agent-dir> ...
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

`npm create @linuxdevil/lousho my-agent` runs `lousho init` with the same arguments.
To scaffold against an unreleased build of the SDK, pass `--sdk-path` (see
[Installing from a local build](./installation.md#installing-from-a-local-build)).

## `lousho dev`

```bash
npx @linuxdevil/lousho dev agent.yaml                  # a spec file
npx @linuxdevil/lousho dev ./my-agent                  # an agent directory
npx @linuxdevil/lousho dev src/agent.ts                # a TypeScript (or JavaScript) module
npx @linuxdevil/lousho dev agent.yaml --port 4000 --host 0.0.0.0
npx @linuxdevil/lousho dev ./my-agent --no-schedules   # do not fire cron schedules or a spec's cron triggers
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
`npx @linuxdevil/lousho traces` shows what the agent did. It is off by default because the
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
npx @linuxdevil/lousho chat agent.yaml                          # a spec file
npx @linuxdevil/lousho chat ./my-agent --model openai/gpt-4o    # an agent directory, on another model
npx @linuxdevil/lousho chat src/agent.ts --store sqlite:.lousho/chat.db --session support
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
npx @linuxdevil/lousho build --target=node-server --agent=agent.yaml        # or docker / cloudflare-worker
npx @linuxdevil/lousho build ./my-agent --target=node-server                # an agent directory (node-server, docker)
npx @linuxdevil/lousho build src/agent.ts --target=node-server              # an agent module (node-server, docker)
```

Writes the artifact to `--out` (default `.lousho/build/<target>`) and prints
the command to run or deploy it. Building needs `tsup`
(`npm install --save-dev tsup`). Targets, the HTTP API they serve and the
Workers limits are in [Deployment](./deployment.md).

## `lousho studio`

```bash
npx @linuxdevil/lousho studio            # prints http://127.0.0.1:4750/?token=<per-launch token>
npx @linuxdevil/lousho studio --port 5000
```

Starts one local server for the Agent Forge API and UI. Agents and run state
are stored under `.lousho/` in the current directory. The app has a left
navigation: Agents (the builder) and Playground, then Traces, Threads and
Monitoring, Evaluations (Scores, Datasets, Evaluators, Annotation queues),
Prompts, Context Hub and Settings; everything past the Playground reads the
`lousho observe` daemon. See [Agent Forge](./agent-forge.md) for the screens
and the walkthrough.

## `lousho observe`

```bash
npx @linuxdevil/lousho observe start                        # collector on http://127.0.0.1:7777
npx @linuxdevil/lousho observe status                       # health + fleet counts
npx @linuxdevil/lousho observe stop                         # <db>.pid + SIGTERM (checks the daemon serves --db)
npx @linuxdevil/lousho observe rebuild-rollups              # recompute insight aggregates
npx @linuxdevil/lousho observe prune --older-than 30d       # delete finished runs older than 30 days, then VACUUM
npx @linuxdevil/lousho observe export --since 7d --out runs.jsonl # traces as JSONL, one per line
npx @linuxdevil/lousho observe failures --since 7d          # recurring tool and model failures, by agent
npx @linuxdevil/lousho observe failures --traces .lousho/traces --json # the same from trace files, no database
npx @linuxdevil/lousho observe score --agent support        # continuous score, pass rate and trajectory gate state
npx @linuxdevil/lousho observe token create --project myapp # bearer key for non-loopback auth
```

Runs the local collector every agent reports to when `LOUSHO_OBSERVE` is
set: traces, fleet monitoring, eval scores, the prompt registry and the
context hub in one SQLite file (default `~/.lousho/observe.db`). Studio's
[daemon screens](./agent-forge.md#screens) read it. `start` takes
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
npx @linuxdevil/lousho prompt push prompt.md --name mira    # publishes a new version
npx @linuxdevil/lousho prompt list
npx @linuxdevil/lousho prompt get mira@latest
npx @linuxdevil/lousho prompt label mira prod 3             # mira@prod -> 3 (was 2)
npx @linuxdevil/lousho prompt get mira@prod
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

## `lousho improve`

Experimental, like the [`improveAgent()`](./improve.md) it runs.

```bash
npx @linuxdevil/lousho improve ./my-agent --check ./check.mjs --since 7d --out proposal.md
```

```js
export default (input, answer) => !answer.includes('I cannot help');
```

It takes the failed runs in your local observe database (default
`~/.lousho/observe.db`, or `--db`), replays each recorded input through the
agent, scores each answer with your check, and prints the review card from
`formatImproveResult()`. On an agent directory it then runs one self-healing
cycle with `healOnce()`: only failed runs of the current harness revision count,
a proposal that passes the gate is replayed on fresh runs (the canary), and in
auto mode (the default) it is written to `instructions.md` and
`skills/<name>/SKILL.md`, after which the corpus guard replays the protected
cases and rolls back on a regression. In manual mode it is queued for
`lousho improve approve`. Every step is audited, and `improve.json`'s daily caps,
the cooldown after a rollback and the `.lousho/improve.stop` kill switch apply.
`--dry-run` keeps the old behaviour: every failed run counts, the card is
printed, and nothing is written. An agent module, or an agent whose instructions
don't live in `instructions.md`, always runs dry.

- `<path>` is an agent directory or a `.ts`/`.js` agent module whose
  instructions are plain text. Editors may change only the instructions and
  skills.
- `--check <module>` is required. Its default export is a `CaseCheck`,
  `(input, answer) => boolean | null | { passed, failure? }`; `null` means the
  answer can't be scored. Return `{ passed: false, failure }` to name the check
  a failed answer missed: the editors read it in that run's record, and without
  it a failed run whose answer looks right gives them nothing to fix.
  `input` is the user's message for a one-message run, else the recorded
  messages as JSON text.
- `--since` and `--agent` pick which failed runs become cases, as for
  `lousho observe export`.
- `--protect <traceId>` names a run that went well. It joins the gate only
  after it passes 6 of 6 fresh runs; otherwise stderr says why it was left out.
  A trace that is also a failed run stays a case to learn from.
- Tools are simulated during replays, except `load_skill` and
  `read_skill_file`. `--read-only <tool>` lets a tool that is safe to call
  again run for real. Replays aren't traced: `LOUSHO_OBSERVE`, the agent's
  `exporter` and `onEvent` are off while it runs, so they never reach your
  database.
- `--model` runs the agent on another model; `--editor` picks the editors'
  model (default `--model`, else the agent's own).
- `--out file` also writes the card, or the JSON result for a `.json` path. It
  must be a new file, outside the agent's files.
- `--max-tokens <n>` passes `maxTokens` to `improveAgent()`: it stops once `n`
  tokens are spent on agent runs and editor calls. The total is checked after
  each run or editor call, so the last one can go over. The card and the JSON
  then report `budget-exceeded` with the reason, nothing is proposed, and
  stderr suggests raising it. `n` must be a positive integer; anything else is
  a usage error (exit 2). It is unset by default, so there is no cap. The runs
  that admit `--protect` traces happen before and don't count toward it.
- `--with-recoveries` also shows the editors, for each failed run, the
  `<id>.heal` fork from `agent.recover()` that finished and whose answer passes
  `--check`, if there is one. It's evidence only: it never counts as a run and
  never protects a case, and a fork you `--protect` is left out. See
  [Recovery forks as evidence](./improve.md#recovery-forks-as-evidence).
- `--approval auto|manual` sets the approval mode, over the
  `LOUSHO_IMPROVE_APPROVAL` variable, which wins over `"approval"` in
  `improve.json` beside the agent. The default is `auto`. In `manual` mode an
  edit that quotes a failed check word for word is kept and flagged on the card
  for the person who approves it; in `auto` mode it is sent back to the editor
  once and then dropped. An `improve.json` that doesn't validate stops the
  run. See [Approval modes](./improve.md#approval-modes).
- `--proposers <1-4>`, `--mode agg|seq`, `--select` and
  `--no-parallel-editors` set the cycle's
  [Harness² options](./improve.md#harness-options), over the `editors` block in
  `improve.json`. `--select` can only turn the selector on and
  `--no-parallel-editors` can only turn parallel off. `--proposers k` runs k invariant and k domain editors (or k
  rounds with `--mode seq`), and costs about k times the editor sessions and
  proposal runs. `--select` gates every candidate and lets the advisory selector
  choose among those that pass. `--no-parallel-editors` runs the editors and
  their probes one at a time, for a rate-limited model. They apply to dry runs
  and `--watch` too.
- `--dry-run` writes nothing: no apply, no queue, no audit entry. It reads
  every failed run whatever its revision, and ignores the kill switch and the
  daily caps.
- `--watch` keeps running cycles on a timer; `--interval` (default `15m`, as
  `<N>s`, `<N>m` or `<N>h`) sets the spacing. It needs an agent directory, takes
  its budget from `improve.json`, and can't be combined with `--dry-run`,
  `--max-tokens` or `--out`. See below.

Before it starts, a cycle prints its approval mode and whether it applies or
queues; a dry run prints how many runs it will make at least, and the token
budget if any. Every run and every editor call is billed to your models.
`--max-tokens` caps one cycle within `improve.json`'s daily caps.
It exits 1 on an `outage`: no run could be scored, or the editors' provider
failed. A `budget-exceeded` run exits 0, since you set the cap. Each run's error goes to
stderr. It reads nothing but your own database. See [Improving an agent](./improve.md#from-the-command-line).

### Revisions, rollback and the audit log

Every change to an agent directory's `instructions.md` and
`skills/<name>/SKILL.md` made through `applyProposal()` is saved as a revision
under `.lousho/revisions/` and recorded in the hash-chained
`.lousho/audit.jsonl`. Three subcommands read and undo that history:

```bash
npx @linuxdevil/lousho improve revisions ./my-agent
npx @linuxdevil/lousho improve rollback ./my-agent --by ali --reason "answers got worse"
npx @linuxdevil/lousho improve audit ./my-agent --verify
```

- `revisions <dir> [--json]` lists the saved revisions, newest first, with their
  source (`baseline`, `apply` or `rollback`), who made them and when. `*` marks
  the one the directory holds now.
- `rollback <dir> --by <name> [--to <revision>] [--reason text]` restores a
  saved revision through the same writer as an apply: it changes only
  instructions and skills, makes a new revision and writes one `rollback` audit
  entry. It never rewrites history. Without `--to` it goes to the parent of the
  current revision. It refuses instead when the current revision came from a
  rollback, or when the directory holds hand edits that match no revision; pass
  `--to` then. A hand edit that a rollback replaces is saved as a revision
  first. `--to` takes an id or a unique prefix of at least 4 characters. `--by`
  is required. If an apply lands between your command and the write, the
  rollback is refused as stale.
- `audit <dir> [--verify] [--json]` prints the audit log, oldest first.
  `--verify` checks the hash chain and exits 1 at the first edited, removed or
  truncated line.

A directory literally named `revisions`, `rollback`, `audit`, `pending`,
`approve`, `reject`, `pause`, `resume` or `status` must be passed as
`./revisions` and so on.

### Pending proposals (manual mode)

In manual mode a proposal that passed the gate waits in
`.lousho/proposals/<id>.json` until a person decides:

```bash
npx @linuxdevil/lousho improve pending ./my-agent
npx @linuxdevil/lousho improve approve ./my-agent 3f9c0a1b2d4e --by ali --check ./check.mjs
npx @linuxdevil/lousho improve reject ./my-agent 3f9c0a1b2d4e --by ali --reason "too broad"
```

- `pending <dir> [--show <id>] [--json]` lists the queue, newest first, marking
  stale and refused entries. The id is the first 12 characters of the proposed
  harness's hash, and a file whose content doesn't match its id is left out.
  `--show <id>` prints that proposal's review card.
- `approve <dir> <id> --by <name> [--check <module>] [--model provider/model]
  [--read-only tool]... [--no-guard] [--db path]` applies the proposal through
  `applyProposal()` as that person's approval and removes it from the queue.
  With `canary.traffic` set, it starts the
  [traffic canary](./improve.md#live-traffic-canary-opt-in) instead and writes
  nothing yet, reading the observe database at `--db` (default
  `~/.lousho/observe.db`); the proposal is applied as that approval when the
  canary passes, and the watcher guards it then. A
  proposal whose agent directory changed since it was made is refused and
  marked stale; run improve again. Any other refusal is recorded on the entry
  and shown by `pending`. Right after the write it runs the corpus guard, as an
  automatic apply does: `guard.runs` fresh runs of every corpus case, scored by
  `--check`, with tools simulated unless `--read-only` names them. If a case
  regressed or the guard can't judge (a run that errors counts as unscored, and
  its error goes to stderr), the edit is rolled back to the approved
  revision's parent and `approve` exits 1. If the directory changed between the
  write and the guard, the guard doesn't run and `approve` exits 1 too. The guard's tokens count toward
  today's budget. With cases in the corpus, `--check` is required, and the
  agent and the check are loaded before anything is written. `--no-guard`
  skips the guard and leaves it to a watcher's next scheduled guard. An empty
  corpus needs neither.
- `reject <dir> <id> --by <name> [--reason text]` records a `reject` audit entry
  and moves the file to `.lousho/proposals/rejected/`. A rejected proposal is
  never queued again.

### Watching, pausing and status

`--watch` keeps the loop running on an agent directory:

```bash
npx @linuxdevil/lousho improve ./my-agent --check ./check.mjs --watch --interval 15m
npx @linuxdevil/lousho improve pause ./my-agent --reason "release freeze" --by ali
npx @linuxdevil/lousho improve resume ./my-agent --by ali
```

Each tick checks the kill switch (`.lousho/improve.stop`, `LOUSHO_IMPROVE=off`
or `"enabled": false`, audited once as `pause`), takes a lease so only one
watcher runs per directory, runs the post-apply monitor, replays the corpus
every `guard.everyHours`, and then runs one cycle within the daily caps. A tick
with the same failures as the last one and no new failed run is skipped.
Three outages in a row write the stop file. Editor calls are limited to
`rateLimit.rpm` a minute. Ctrl-C stops after the current step. `pause` writes
the stop file and `resume` removes it; both are audited. `resume` doesn't
undo `LOUSHO_IMPROVE=off` or `"enabled": false`. While the loop is paused, the
monitor doesn't run either, so nothing is rolled back automatically. Only a
watcher runs the monitor: a single `lousho improve` cycle doesn't. See
[Running it continuously](./improve.md#running-it-continuously).

`lousho improve status <dir> [--json]` prints the mode and active revision, the
last 5 audit entries, pending proposals, the monitor's verdict (with a warning
while it waits for runs or kept an edit unverified), what is left of today's
budget, the cooldown, the kill switch, the canary and the editor options a
cycle uses (from `improve.json` and the defaults). The watcher's events go
to the `alerts.json` webhooks beside the observe db (see
[Observability](./observability.md)).

### `improve.json`

Self-healing settings live in `improve.json` beside the agent. Every key is
optional, and an unknown key or a bad value is an error
(`LOUSHO_CONFIG_INVALID`):

```json
{
  "approval": "auto",
  "budget": { "maxTokensPerDay": 2000000, "maxCyclesPerDay": 4, "maxAppliesPerDay": 1 },
  "trigger": { "minNewFailures": 3, "requireRecurring": true },
  "canary": { "replayRuns": 6 },
  "monitor": { "minRuns": 20, "window": 20, "maxDrop": 0.05, "autoRollback": true, "giveUpDays": 7 },
  "guard": { "runs": 3, "everyHours": 24, "maxCases": 30 },
  "cooldownHours": 24,
  "rateLimit": { "rpm": 20 },
  "library": { "enabled": true },
  "editors": { "proposers": 1, "mode": "agg", "select": false, "parallel": true }
}
```

These are the defaults. Counts are whole numbers of 1 or more, and `maxDrop` is
between 0 and 1, and `editors.proposers` is 1 to 4. `requireRecurring`
defaults to `false` in manual mode.
`"enabled": false` stops the loop for this agent. `budget.maxTokensPerCycle`,
`canary.traffic` (`share` up to 0.25, `sessions` up to 50) and `library.domain`
are unset unless you set them. With `canary.traffic` set, a proposal that
passes the replay canary (in auto mode), or that a person approves (in manual
mode), starts the
[live traffic canary](./improve.md#live-traffic-canary-opt-in), which serves it
to real sessions, instead of being written.
`loadImproveSettings()` reads the file. See
[Settings](./improve.md#settings) for what each key does.
