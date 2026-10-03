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
'@lousho/build-ai-agent'` import in a tool is the SDK the server runs), and the
rest of the directory is copied; nothing needs a TypeScript loader at run time.
`dist/` is then ESM (`dist/package.json` says so). The Docker image copies it as
before. The optional `dockerode` sandbox is not bundled (it loads lazily), so a
directory that uses `SubprocessSandbox` must install it where it runs.

The Cloudflare Worker target builds a directory's config, `instructions.md`,
`tools/` and `skills/`; it rejects `subagents/`, `schedules/`, `channels/`,
`memory/`, `projectInstructions` and a `model` whose provider the Worker lacks,
naming what to remove. Tools run inside the Worker with its rights, and may import
only a Worker-safe part of `@lousho/build-ai-agent`
([Cloudflare Workers](./cloudflare-workers.md#build-and-deploy) has the details):

```bash
npx lousho build ./my-agent --target=cloudflare-worker
```

## HTTP API

Every target serves the same `/chat` protocol as `lousho dev`
([CLI](./cli.md#lousho-dev)), from the same code (the Fetch-native
`src/server/fetchRoutes.ts`, which the Node server and the Worker both call), so
a page or script written against the dev server works against the deployed one.

| Endpoint | What it does |
| -------- | ------------ |
| `GET /health` | `200 ok`. Never needs auth: point load balancers and container health checks here. |
| `POST /chat` `{ "sessionId", "input" }` | Runs a turn of session `sessionId` (1-128 characters of `A-Za-z0-9_-`; a new id starts a conversation, a known one continues it) and streams it as SSE: one `data: <AgentEvent JSON>` per event ([Streaming](./streaming.md)), then `event: done`. `input` is a string or an array of content parts. |
| `GET /chat/:sessionId` | The session's transcript: `{ sessionId, messages, pending }`. |
| `POST /chat/:sessionId/approvals/:id` `{ "approved", "note"? }` or `{ "answer" }` | Decides a pending tool approval, or answers an `ask_question`, and streams the continued turn live as SSE, in the same framing and event types as `POST /chat` (the decided call's `tool.start` / `tool.done` or `tool.error`, text deltas, `approval.requested` if it pauses again, `run.done`), from `agent.approvals.streamResolve()` / `streamAnswer()`. `404` when `id` is not pending. |
| `POST /chat` `{ "message" }` | Legacy, single turn without history or streaming: returns the agent's `ExecutionResult` as JSON, with a `Deprecation: true` header. |

Bodies over 1MB get `413`, invalid JSON `400`.

```bash
curl -N http://127.0.0.1:3000/chat \
  -H 'Authorization: Bearer '"$LOUSHO_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "sessionId": "alice", "input": "Hello" }'
```

### Auth

Set `LOUSHO_API_TOKEN` (on the Worker target, as a secret: `npx wrangler secret
put LOUSHO_API_TOKEN`) and every route except `/health` requires
`Authorization: Bearer <token>`; anything else gets `401` with a JSON error
(the token is compared in constant time). Without it the server is open: that
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
`LOUSHO_API_TOKEN` binding only.

For JWT, OpenID Connect or Basic auth, and to know who is calling, the
`node-server` and `docker` targets take an ordered auth list from an agent
directory's `auth.ts`, with `LOUSHO_API_TOKEN` appended to it: see
[Route auth and principals](./auth.md).

### Sessions and the store

`LOUSHO_STORE` chooses where sessions, checkpoints and approvals live:

| Value | Store |
| ----- | ----- |
| `memory` (default) | `memoryStore()`: gone when the process restarts, and not shared between instances. |
| `sqlite:<path>` | A [`SqliteStore`](./sessions.md) file (created with its directory): sessions survive restarts. Needs Node 22 (`node:sqlite`); the `docker` image uses `node:22-slim`. Mount the file's directory as a volume. |

SQLite is one file on one disk, so run a single instance per database file.

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
`PORT`, or defaults to `3000`. SIGINT/SIGTERM close the agent before exiting.
Provider credentials are read from the same
environment variables as everywhere else (`OPENAI_API_KEY`, ...).

## `docker`

Reuses the `node-server` scaffold and bundle and adds a `Dockerfile` based
on `node:22-slim` that copies `dist/` and runs `node dist/server.js` on port
3000. The image sets `HOST=0.0.0.0` - inside a container the server has to
listen on all interfaces for `docker run -p` to reach it. Pass provider
credentials at run time:

```bash
cd .lousho/build/docker
docker build -t lousho-agent .
docker run -p 3000:3000 -e OPENAI_API_KEY=... lousho-agent
```

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
ones the agent needs where the server runs - `@lousho/build-ai-agent` (pinned
to the version that built it), the provider package the spec names (at the
range pairing with the build's `ai` major, e.g. `@ai-sdk/openai` for an OpenAI
agent) and `@modelcontextprotocol/sdk` when the spec has `mcpServers` - so the
docker image's `npm install --omit=dev` or a `npm install` next to the
node-server output installs them. Anything else (an agent directory's own
imports, `dockerode` for sandboxed tools) you add yourself; a code path that
needs one that is missing raises the SDK's coded missing-peer error. A spec's cron triggers run on the node-server and docker targets as well as on Workers
([Schedules](schedules.md#on-the-node-server)).

## Custom targets

Targets are `DeploymentAdapter` objects (`scaffold`, `build`, `describe`)
registered by name with `registerAdapter()`; both are exported from the
package root.
