# Deployment

`lousho build` turns an agent spec file (see [Configuration](./configuration.md))
into a deployable artifact for one target platform:

```bash
npx lousho build --target=<target> --agent=agent.yaml [--out=<dir>]
```

It runs the target's adapter through three steps - **scaffold** (write the
entrypoint and platform files into `--out`, default `.lousho/build/<target>`),
**build** (bundle with `tsup`) and **describe** (print the command to run or
deploy the result). `tsup` must be installed (`npm install --save-dev tsup`).

| Target              | Output                                                   | Printed command                                                        |
| ------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `node-server`       | `server.ts`, `agent.config.js`, `package.json`, `dist/server.js` | `node dist/server.js`                                                  |
| `docker`            | everything `node-server` writes, plus `Dockerfile`       | `docker build -t lousho-agent . && docker run -p 3000:3000 lousho-agent` |
| `cloudflare-worker` | `worker.ts`, `agent.config.js`, `wrangler.toml`, `dist/worker.js` | `wrangler deploy`                                                      |

Every target answers `GET /health` (`200 ok`) and serves the full
[HTTP API](#http-api) below: sessions, SSE streaming, approvals and bearer auth.

For a real VPS walkthrough — provision check, build, ship, run, verify — see
[Deploying to a Hostinger VPS](./hostinger-vps.md).

## Agent directories

All three targets also take an [agent directory](./agent-directories.md)
in place of a spec file (the path may be positional or `--agent`):

```bash
npx lousho build ./my-agent --target=node-server
node .lousho/build/node-server/dist/server.js
```

The generated `server.ts` calls `resolveAgentDir()` on `dist/agent` and
`createDeployedServer(agent, { schedules, channels })`, so the process starts the
directory's [schedules](./schedules.md) when it listens, mounts its
[channels](./channels.md) under `/channels` (they verify themselves; the chat
routes keep the bearer token), and logs `schedules: ...; channels: ...`.
The directory's code files are pre-bundled with the build's tsup step into
`dist/agent/**.js` (one ESM build sharing one copy of the SDK, so a `from
'@lousho/build-ai-agent'` import in a tool is the SDK the server runs), and
only the files the server reads as data are copied: `instructions.md`,
`instructions/`, `skills/`, a JSON/YAML config, and the same in each
`subagents/<name>/`. Nothing else in the directory reaches `dist/`: not `.env`
files, not the `.lousho/` session store or a config's `store.dir`, not notes or
data files. `dist/` is emptied before each build, so sessions a previous build's
server wrote under it do not carry over. Nothing needs a TypeScript loader at
run time. `dist/` is then ESM (`dist/package.json` says so). The Docker image
copies it as before. The optional `dockerode` sandbox is not bundled (it loads lazily), so a
directory that uses `SubprocessSandbox` must install it where it runs.

The Cloudflare Worker target builds a directory's config, `instructions.md`,
`tools/`, `skills/`, `subagents/`, `schedules/` (as Worker cron triggers),
`channels/`, `memory/` and `projectInstructions`; it rejects a `model` whose
provider the Worker lacks, and the other features the Worker column of
[What works and what does not](./cloudflare-workers.md#what-works-and-what-does-not)
leaves out, naming what to remove. Tools run inside the Worker with its rights, and may import
only a Worker-safe part of `@lousho/build-ai-agent`
([Cloudflare Workers](./cloudflare-workers.md#build-and-deploy) has the details):

```bash
npx lousho build ./my-agent --target=cloudflare-worker
```

## Agent modules

The `node-server` and `docker` targets also build a `.ts`/`.js` module whose
default (or `agent`) export is `createAgent()` options or a built agent: the
same file `lousho dev src/agent.ts` serves, and what the minimal and tools
scaffolds have (their `npm run build` runs this):

```bash
npx lousho build src/agent.ts --target=node-server
node .lousho/build/node-server/dist/server.js
```

The generated `server.ts` imports the module, so tsup bundles it with its local
imports and the SDK into an ESM `dist/server.js`. With an options export the
server builds the agent with `LOUSHO_STORE` (unless the options name a
`store`); an exported agent keeps its own. The build's `package.json` names
the provider package when the module has a literal `model: '<provider>/...'` or
names an SDK provider class (`new OpenRouterProvider(...)`); only the entry file
is scanned, and the build warns when it finds no provider. Add any other
optional peer it needs to `dependencies` yourself. The `cloudflare-worker` target
does not build a module: use a spec or an agent directory.

## HTTP API

Every target serves the same `/chat` protocol as `lousho dev`
([CLI](./cli.md#lousho-dev)), from the same code (the Fetch-native
`src/server/fetchRoutes.ts`, which the Node server and the Worker both call), so
a page or script written against the dev server works against the deployed one.

| Endpoint | What it does |
| -------- | ------------ |
| `GET /health` | `200 ok`. Never needs auth: point load balancers and container health checks here. |
| `POST /chat` `{ "sessionId", "input" }` | Runs a turn of session `sessionId` (1-128 characters of `A-Za-z0-9_-`; a new id starts a conversation, a known one continues it) and streams it as SSE: one `data: <AgentEvent JSON>` per event ([Streaming](./streaming.md)), then `event: done`. `input` is a string or an array of content parts. |
| `GET /chat/:sessionId` | The session's transcript: `{ sessionId, messages, pending }`. A turn's messages are saved when it finishes, so `messages` does not hold a turn that is paused on an approval; `pending` says it is. |
| `POST /chat/:sessionId/approvals/:id` `{ "approved", "note"? }` or `{ "answer" }` | Decides a pending tool approval, or answers an `ask_question`, and streams the continued turn live as SSE, in the same framing and event types as `POST /chat` (the decided call's `tool.resume` / `tool.done` or `tool.error`, text deltas, `approval.requested` if it pauses again, `run.done`), from `agent.approvals.streamResolve()` / `streamAnswer()`. `404` when `id` is not pending; `409` (`LOUSHO_APPROVAL_CONFLICT`) while another request's decision of it is still streaming; `400` (`LOUSHO_APPROVAL_DECISION_INVALID`) for a body with neither field. When the turn's step paused on several calls, each id is decided on its own; a decision that leaves others pending streams `run.done` with `finishReason: 'awaiting-approval'`, and the last one runs the step. |
| `POST /chat` `{ "message" }` | Legacy, single turn without history or streaming: returns the agent's `ExecutionResult` as JSON, with a `Deprecation: true` header. |

Bodies over 1MB get `413`, invalid JSON `400`. A POST must send
`Content-Type: application/json` (anything else is `415`,
`LOUSHO_UNSUPPORTED_MEDIA_TYPE`), and a browser POST from another origin is
`403` (`LOUSHO_REQUEST_FORBIDDEN`): see
[Cross-site requests](./auth.md#cross-site-requests). An empty `input`, or a
body without `sessionId` and `input`, is `400` (`LOUSHO_REQUEST_INVALID`; an
invalid session id is `LOUSHO_SESSION_ID_INVALID`). Every error body is JSON
`{ error, code }`. A turn sent to a session that is paused on an approval is
`409` with `code: 'LOUSHO_SESSION_AWAITING_APPROVAL'`, `approvalId` and
`approvalIds` (every approval still to decide): decide them through the
approvals route, which streams the paused turn's continuation, then send the
new turn. A turn sent to a session that another process or replica is running a
turn of (it holds the session's run lease) is `409` with
`code: 'LOUSHO_SESSION_BUSY'` and a `Retry-After: 2` header, answered before
any stream starts; resend after the wait. With an auth list, a session belongs to the first principal that sends
it a turn, and a stored session whose owner the server no longer remembers
(after a restart) is refused to everyone until `authorizeSession` says whose
it is; with only `LOUSHO_API_TOKEN` there is one caller and no owner check
([Who may use a session](./auth.md#who-may-use-a-session)). An approval is
decided only by the caller its run acts for unless `authorizeApproval` says
otherwise. In an agent directory, export `authorizeSession` and
`authorizeApproval` from `auth.ts` to change either rule (for example, to let
a manager decide other users' approvals): see
[Who may decide an approval](./auth.md#who-may-decide-an-approval).

While a turn streams, the server writes an SSE comment line (`: ping`) after
every 15 seconds without an event, so a proxy (nginx closes an idle upstream
after 60s) or a client (Node's `fetch` gives up after 300s without a byte)
keeps the connection while a model or a tool is slow. SSE parsers ignore
comment lines. `createRouteHandler(agent, { heartbeatMs })` changes the
interval; `0` turns it off.

```bash
curl -N http://127.0.0.1:3000/chat \
  -H 'Authorization: Bearer '"$LOUSHO_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "sessionId": "alice", "input": "Hello" }'
```

### Resending a turn

A `POST /chat` that the client sends again (a retry after a dropped
connection or a timeout, a double click, a client that restarted) is, without
more, a new turn: the user message is appended again and the model may call
the same tools again. Send an `Idempotency-Key` header (1-255 visible ASCII
characters, e.g. a UUID the client makes per message) and resend with the
same key:

| The turn of that key in that session | The resend gets |
| ------------------------------------ | --------------- |
| finished (it is in the transcript) | `200` SSE with one `run.done` carrying that turn's final reply (`text`, `finishReason`), and the header `Idempotent-Replayed: true`. Nothing runs. Read `GET /chat/:sessionId` for the whole turn. |
| still running, on this server process or on another replica that shares the store | `409` (`LOUSHO_SESSION_BUSY`) with `Retry-After: 2`. Retry after the wait and get the replay. |
| interrupted by a crash (a checkpointed turn left `in-progress`) | the turn resumed from its last checkpoint (`session.resume()`: finished steps and tool calls are not run again), streamed as SSE. |
| none | a new turn, as without the header; its user message keeps the key (`metadata.idempotencyKey`). |

A session paused on an approval answers `409`
(`LOUSHO_SESSION_AWAITING_APPROVAL`) to a resend as to any turn. The key is
stored with the turn in the session store (the transcript, or the turn's
checkpoint until it finishes), so a replay works after a restart and on another
replica that shares the store; `session.pending()` reports an interrupted
turn's key as `idempotencyKey`. A key is looked up only in its own session,
and only while its turn is in the transcript (a compaction that summarizes it
away forgets it). Across replicas the `409` rests on the session's run lease, so it needs a
store that supports leases; two replicas that receive the same key at the same
instant on a store without them can both run it.

```bash
curl -N http://127.0.0.1:3000/chat -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 6f1c2b0e-7d4a-4c8e-9a51-2f0d3b6e8c11' \
  -d '{ "sessionId": "alice", "input": "Refund order B-1" }'
```

### Auth

Set `LOUSHO_API_TOKEN` (on the Worker target, as a secret: `npx wrangler secret
put LOUSHO_API_TOKEN`) and the `/chat` routes and any channel without its
own `verify` require `Authorization: Bearer <token>`; anything else gets `401`
with a JSON error (the token is compared in constant time). `/health` is
open, and channels that authenticate themselves (a `verify` function, or a
platform signature check such as Slack's) are not gated by the token. Without it the server is open: that
is fine on `127.0.0.1`, but **treat the token as required for anything that is
not on localhost** (the server logs a warning when it listens on another
interface without one, and the `docker` image listens on all interfaces).
Terminate TLS in front of the server, since a bearer token travels in clear
text over plain HTTP. Pass the token at run time (`docker run -e
LOUSHO_API_TOKEN=...`).

Programmatically, `adapter.scaffold(agentPath, outDir, { auth: { token } })`
bakes a token into the built `node-server` or `docker` server for when the
variable is not set. The variable wins, and a baked token is readable in
`dist/server.js`, so prefer the variable. The Worker reads the token from its
`LOUSHO_API_TOKEN` binding only; without one it refuses every `/chat` route
unless the `LOUSHO_ALLOW_OPEN_SESSIONS` var is `"true"`
([Cloudflare Workers](./cloudflare-workers.md)).

Behind a proxy, or for a front end on another origin, the generated
`node-server` and Worker read the routes' request checks from
`LOUSHO_ALLOWED_ORIGINS` and `LOUSHO_ALLOWED_HOSTS` (comma-separated) and
`LOUSHO_REQUIRE_JSON_BODY=false`: see
[Cross-site requests](./auth.md#cross-site-requests).

For JWT, OpenID Connect or Basic auth, and to know who is calling, the
`node-server` and `docker` targets take an ordered auth list from an agent
directory's `auth.ts`, with `LOUSHO_API_TOKEN` appended to it: see
[Route auth and principals](./auth.md).

### Sessions and the store

`LOUSHO_STORE` chooses where sessions, checkpoints and approvals live:

| Value | Store |
| ----- | ----- |
| `memory` (default) | `memoryStore()`: gone when the process restarts, and not shared between instances. |
| `sqlite:<path>` | A [`SqliteStore`](./sessions.md) file (created with its directory): sessions survive restarts. Needs Node 22 (`node:sqlite`); the `docker` image uses `node:22-slim`. Mount the file's directory as a volume (the `docker` image owns `/app/data` for this). |

SQLite is one file on one disk, so run a single instance per database file.

### Crash recovery

When the `node-server` or `docker` server starts listening, it finishes the
runs that a crash or a kill left unfinished in the store. It calls
[`agent.recover()`](./durable-execution.md), which resumes every
`in-progress` run and session turn from its last checkpoint. Steps that
completed are not run again. A tool call that was in flight when the process
died runs again, so make such tools idempotent. The server logs
`lousho server: resuming N interrupted run(s)` when it finds any, and one
`recovered interrupted run '<id>'` line per run it finishes. It then checks
the store again every 30 seconds until it shuts down.

- Runs paused on an approval or a question are left alone. Decide them
  through `POST /chat/:sessionId/approvals/:id`.
- A run whose [run lease](./durable-execution.md#run-leases) another live
  process holds is skipped and retried on a later check. So is a run whose
  crashed process's lease has not expired yet.
- With the default `memory` store there is nothing to recover after a
  restart, and the check finds nothing.
- A resend of the same turn that arrives while the server is still resuming
  it runs after the resumed turn, as a new turn. Send an `Idempotency-Key`
  ([Resending a turn](#resending-a-turn)) to get the resumed turn's reply
  instead.

Set `LOUSHO_RECOVER_ON_START=0` to turn this off, for example when another
process already runs `agent.recover()` for the same store.

## `node-server`

`dist/server.js` is a single self-contained bundle (the SDK and its
dependencies are included), so it runs without `npm install`:

```bash
cd .lousho/build/node-server
node dist/server.js                   # http://127.0.0.1:3000
node dist/server.js --port=8080 --host=0.0.0.0
```

Like `lousho dev`, it binds to `127.0.0.1` unless you opt in to another
interface with `--host=<h>` (or `HOST=<h>`); the port comes from `--port`,
`PORT`, or defaults to `3000`.

On SIGINT or SIGTERM (a `docker stop`, a rolling deploy) the server drains
before it exits:
1. It stops accepting connections.
2. It stops the schedules, so nothing fires again.
3. It waits for the requests and turns already running, including schedule
   fires and turns whose client disconnected. The wait is capped at 10 seconds,
   or `LOUSHO_SHUTDOWN_TIMEOUT_MS`.
4. It closes the connections still open and calls `agent.close()`.

Keep the platform's grace period (Docker's `--stop-timeout`, Kubernetes'
`terminationGracePeriodSeconds`) longer than that wait. The drain is part of
the generated server; `createDeployedServer()` is an internal helper of that
bundle and is not exported. When you serve the agent yourself (for example
`createRouteHandler()` behind your own `node:http` server), do the same in your
signal handler: stop accepting, let the requests in flight finish, then call
`agent.close()`.

```ts
import { createServer } from 'node:http';
import { createAgent, mountChannels } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });
const handler = mountChannels(agent, []);
const server = createServer((req, res) => void handler(req, res).then((handled) => handled || res.writeHead(404).end()));
server.listen(3000);

process.once('SIGTERM', () => {
  server.close(() => void agent.close()); // close() waits for open connections
  setTimeout(() => server.closeAllConnections(), 10_000).unref(); // then cut the stragglers
});
```

Provider credentials are read from the same
environment variables as everywhere else (`OPENAI_API_KEY`, ...).

## `docker`

Reuses the `node-server` scaffold and bundle and adds a `Dockerfile` based
on `node:22-slim` that copies `dist/` and runs `node dist/server.js` on port
3000 as the image's unprivileged `node` user. The image sets `HOST=0.0.0.0` -
inside a container the server has to listen on all interfaces for
`docker run -p` to reach it. For a reproducible image, run
`npm install --package-lock-only` in the output directory once and keep the
`package-lock.json`: the Dockerfile then installs with `npm ci`. Pass provider
credentials at run time:

```bash
cd .lousho/build/docker
docker build -t lousho-agent .
docker run -p 3000:3000 -e OPENAI_API_KEY=... lousho-agent
```

The image creates `/app/data`, owned by `node`, and declares it a `VOLUME`. Docker
copies that ownership into a fresh named volume, so the unprivileged server can write
there without a manual `chown`. Keep sessions across restarts by mounting a volume and
pointing the store at it:

```bash
docker run -p 3000:3000 -e OPENAI_API_KEY=...   -v lousho-data:/app/data -e LOUSHO_STORE=sqlite:/app/data/lousho.db lousho-agent
```

A bind mount (`-v ./data:/app/data`) keeps the host directory's own ownership, so
`chown` it to uid 1000 first.

## `cloudflare-worker`

Generates a module Worker (`export default { fetch }`), a `wrangler.toml` and `dist/worker.js`, bundled as a
browser-platform ES module; the build fails if any `node:` import ends up in the bundle. It needs `tsup` and
`wrangler`, and it serves the [HTTP API](#http-api) above. It has the tightest limits of the three targets:

- spec files, and agent directories with a config, instructions, TypeScript tools and skills (no sub-agents,
  schedules, channels or memory slots from a directory, no sandboxed tools);
- providers `mock`, `openai`, `anthropic` and `openrouter`; built-in tools `current-date`, `day-name` and `http`
  (`http` reaches only the host names listed in the `LOUSHO_HTTP_ALLOW` binding);
- sessions, checkpoints and approvals in one KV namespace; cron triggers in UTC.

[Cloudflare Workers](./cloudflare-workers.md) has the table of limits, the build and deploy commands, the bindings, the KV stores, scheduled runs and the bundle checks.

### Optional peers in node and docker builds

`dist/server.js` bundles the SDK but leaves its optional peers (the `peerDependenciesMeta`
entries of its package.json: provider packages, `dockerode`, the MCP SDK, `prompts`, ...) external, so a build
never needs one you do not use. The generated `package.json` already lists the
ones the agent needs where the server runs - the provider package the spec names (at the
range pairing with the build's `ai` major, e.g. `@ai-sdk/openai` for an OpenAI
agent) and `@modelcontextprotocol/sdk` when the spec has `mcpServers` - and
nothing else: `@lousho/build-ai-agent`, `ai` and `zod` are inside the bundle, so the
docker image's `npm install --omit=dev` or a `npm install` next to the
node-server output installs them. Anything else (an agent directory's own
imports, `dockerode` for sandboxed tools) you add yourself; a code path that
needs one that is missing raises the SDK's coded missing-peer error. A spec's cron triggers run on the node-server and docker targets as well as on Workers
([Schedules](schedules.md#on-the-node-server)).

## Custom targets

Targets are `DeploymentAdapter` objects (`scaffold`, `build`, `describe`)
registered by name with `registerAdapter()`; both are exported from the
package root.
