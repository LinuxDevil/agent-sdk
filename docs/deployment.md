# Deployment

`loushy build` turns an agent spec file (see [Configuration](./configuration.md))
into a deployable artifact for one target platform:

```bash
npx loushy build --target=<target> --agent=agent.yaml [--out=<dir>]
```

It runs the target's adapter through three steps - **scaffold** (write the
entrypoint and platform files into `--out`, default `.loushy/build/<target>`),
**build** (bundle with `tsup`) and **describe** (print the command to run or
deploy the result). `tsup` must be installed (`npm install --save-dev tsup`).

| Target              | Output                                                   | Printed command                                                        |
| ------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `node-server`       | `server.ts`, `agent.config.js`, `package.json`, `dist/server.js` | `node dist/server.js`                                                  |
| `docker`            | everything `node-server` writes, plus `Dockerfile`       | `docker build -t loushy-agent . && docker run -p 3000:3000 loushy-agent` |
| `cloudflare-worker` | `worker.ts`, `agent.config.js`, `wrangler.toml`, `dist/worker.js` | `wrangler deploy`                                                      |

Every target answers `GET /health` (`200 ok`) and serves the full
[HTTP API](#http-api) below: sessions, SSE streaming, approvals and bearer auth.

## HTTP API

Every target serves the same `/chat` protocol as `loushy dev`
([CLI](./cli.md#loushy-dev)), from the same code (the Fetch-native
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
  -H 'Authorization: Bearer '"$LOUSHY_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "sessionId": "alice", "input": "Hello" }'
```

### Auth

Set `LOUSHY_API_TOKEN` (on the Worker target, as a secret: `npx wrangler secret
put LOUSHY_API_TOKEN`) and every route except `/health` requires
`Authorization: Bearer <token>`; anything else gets `401` with a JSON error
(the token is compared in constant time). Without it the server is open: that
is fine on `127.0.0.1`, but **treat the token as required for anything that is
not on localhost** (the server logs a warning when it listens on another
interface without one, and the `docker` image listens on all interfaces).
Terminate TLS in front of the server, since a bearer token travels in clear
text over plain HTTP. Pass the token at run time (`docker run -e
LOUSHY_API_TOKEN=...`).

Programmatically, `adapter.scaffold(agentPath, outDir, { auth: { token } })`
bakes a token into the built `node-server` or `docker` server for when the
variable is not set. The variable wins, and a baked token is readable in
`dist/server.js`, so prefer the variable. The Worker reads the token from its
`LOUSHY_API_TOKEN` binding only.

### Sessions and the store

`LOUSHY_STORE` chooses where sessions, checkpoints and approvals live:

| Value | Store |
| ----- | ----- |
| `memory` (default) | `memoryStore()`: gone when the process restarts, and not shared between instances. |
| `sqlite:<path>` | A [`SqliteStore`](./sessions.md) file (created with its directory): sessions survive restarts. Needs Node 22 (`node:sqlite`); the `docker` image uses `node:22-slim`. Mount the file's directory as a volume. |

SQLite is one file on one disk, so run a single instance per database file.

## `node-server`

`dist/server.js` is a single self-contained bundle (the SDK and its
dependencies are included), so it runs without `npm install`:

```bash
cd .loushy/build/node-server
node dist/server.js                   # http://127.0.0.1:3000
node dist/server.js --port=8080 --host=0.0.0.0
```

Like `loushy dev`, it binds to `127.0.0.1` unless you opt in to another
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
cd .loushy/build/docker
docker build -t loushy-agent .
docker run -p 3000:3000 -e OPENAI_API_KEY=... loushy-agent
```

## `cloudflare-worker`

Generates a module Worker (`export default { fetch }`) and bundles it as a
browser-platform ES module; the build fails if any `node:` import ends up in
`dist/worker.js`. `wrangler.toml` points `main` at `dist/worker.js` with
`no_bundle = true`, so exactly the verified bundle is uploaded. It builds and
runs with `ai` v4 (the default install) or `ai` v7 (with
`@ai-sdk/openai`/`@ai-sdk/anthropic` v4) installed, with no compatibility
flag (no `nodejs_compat`):

```bash
cd .loushy/build/cloudflare-worker
npx wrangler dev       # local workerd runtime
npx wrangler deploy    # requires a Cloudflare account (`wrangler login`)
```

Workers have no Node.js builtins, so this target currently supports:

- providers: `mock`, `openai` and `anthropic`. The `openai`/`anthropic`
  providers are built on the Vercel `ai` SDK's `generateText`/`streamText`
  plus `@ai-sdk/openai`/`@ai-sdk/anthropic`, which are pure
  `fetch()`/Web-standard implementations with no `node:*` imports anywhere
  in their dependency graph, so they bundle and run on Workers cleanly.
  `ollama` and `openrouter` are **not** supported here - `ollama` defaults
  to a local `http://localhost:11434` endpoint that a Worker can't reach,
  and `openrouter` hasn't had a Workers-compatibility audit; use
  `node-server` or `docker` for those;
- tools: `current-date` and `day-name`. `http` is **not** supported: its
  SSRF protection resolves the hostname via `node:dns` and checks *every*
  resolved address against a denylist before connecting (closing a
  DNS-rebinding gap), then, for `validateSSL: false`, pins that TLS setting
  per request via a dedicated `undici` `Agent`. Workers' native `fetch()` has no equivalent hook to
  resolve a hostname up front and pin the connection to the verified IP, so
  a Workers version of this tool built on plain `fetch()` would silently
  drop that protection rather than just losing convenience functionality -
  it's left unsupported rather than shipped weaker under the same name.

`loushy build` rejects a spec that uses anything else, with an error naming
the unsupported provider or tool. Provider API keys are read from Worker
bindings named `<TYPE>_API_KEY` (e.g. `wrangler secret put OPENAI_API_KEY`,
`wrangler secret put ANTHROPIC_API_KEY`) - the `openai`/`anthropic`
peer packages (`@ai-sdk/openai`/`@ai-sdk/anthropic`, `ai`) must be installed
alongside `@loushy/build-ai-agent` for `loushy build` to bundle them.

### Bindings, sessions and the API on Workers

The Worker serves the [HTTP API](#http-api) above: `GET /health`, `POST /chat`
streamed as SSE (`ReadableStream`), `GET /chat/:sessionId`, the approvals
endpoint and the deprecated `{ "message" }` body. Its two bindings:

| Binding | Kind | What it does |
| ------- | ---- | ------------ |
| `LOUSHY_API_TOKEN` | secret (`npx wrangler secret put LOUSHY_API_TOKEN`) | Makes every route except `/health` require `Authorization: Bearer <token>` (constant-time compare, `401` JSON otherwise). Without it the Worker is open to anyone who has its URL, so **set it before you deploy**. |
| `AGENT_CHECKPOINTS` | KV namespace | Holds sessions, checkpoints and paused approvals, in one namespace, as `KVStore` (below). Without it they live in the memory of one isolate, which Cloudflare recycles at will: fine for trying a deploy out, not for production. |

`wrangler.toml` is scaffolded with the `[[kv_namespaces]]` block for
`AGENT_CHECKPOINTS` commented out, with the commands to create the namespace
(`npx wrangler kv namespace create AGENT_CHECKPOINTS`, plus a `--preview`
variant) and where to paste the resulting ids. Uncomment it and fill in the ids.

```bash
cd .loushy/build/cloudflare-worker
npx wrangler secret put LOUSHY_API_TOKEN
npx wrangler secret put OPENAI_API_KEY
npx wrangler deploy
curl -N https://<your-worker>.workers.dev/chat \
  -H "Authorization: Bearer $LOUSHY_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "sessionId": "alice", "input": "Hello" }'
```

`KVStore(kvBinding, { prefix?, ttl? })` (`src/deploy/kvStore.ts`) is the
`AgentStore` the Worker builds from the binding; use it yourself with
`createAgent({ store: new KVStore(env.AGENT_CHECKPOINTS) })` in a Worker you
write. Keys, with an optional `prefix` before each:

| Key | Value |
| --- | ----- |
| `sessions/<id>` | The transcript as JSON (image and file bytes as `{ "$bytes": "<base64>" }`, like `FileSessionStore`). |
| `checkpoints/<id>` | The `Checkpoint` of a durable run or session turn (`KVCheckpointStore`, no history). |
| `approvals/<id>` | A paused approval and the snapshot that resumes it (deleted when it is decided). |

`ttl: { sessions?, checkpoints?, approvals? }` (seconds, KV accepts 60 or more)
makes each kind of record expire that long after its last write; by default
records are kept until deleted.

An approval that pauses a turn on one request can be decided by a later request
on another isolate: the checkpointed session names its pending approval, and the
approvals endpoint continues it from KV. That continuation's events skip the
decided tool call's `tool.done`; its `run.done` carries the final text.

The deprecated `POST /chat { "message", "sessionId"? }` keeps its earlier
behaviour on Workers: with a `sessionId` the run is checkpointed to
`checkpoints/<sessionId>` after each tool result and rehydrated by a later
request that reuses the `sessionId` (after a crash or a recycled isolate).

### Durable execution (pause/resume) on Workers

A Worker's request lifetime is too short-lived for an in-memory or
filesystem-backed `CheckpointStore` (see
[Configuration](./configuration.md) / `src/execution/checkpoint.ts` for
what `CheckpointStore` is and why a run needs one to survive a crash or an
approval-gate pause). `AGENT_CHECKPOINTS` is that store, backed by KV
(`KVCheckpointStore`), and the one binding above is all it takes to opt in.

**Why KV, not D1 or Durable Objects:** a `Checkpoint` is one JSON blob keyed
by `sessionId`, read and written whole - exactly the shape Workers KV is
built for, with zero extra infrastructure beyond a namespace binding. D1
would buy relational query power this store never needs; a Durable Object
would buy strict per-session consistency at the cost of provisioning a DO
class/migration and paying for a stateful object per session. If your
workload genuinely needs strict read-after-write consistency across edge
locations (see the caveat below), a Durable-Object-backed `CheckpointStore`
is the natural upgrade path - implementing the same `CheckpointStore`
interface (`save`/`load`/`delete`) against a Durable Object namespace
instead of a KV namespace.

**Eventual consistency - read this before relying on it for approval
workflows:** Workers KV is an *eventually consistent* store. A `put()` is
immediately visible to the edge location that wrote it, but can take up to
~60 seconds to propagate to other Cloudflare edge locations globally. In
practice this means: if a session's checkpoint is written on one edge
location and a follow-up request for the *same* `sessionId` lands on a
*different* edge location shortly after, that request could still observe
stale data (an older checkpoint, or a miss) rather than what was just
written. This matters most for approval-gated pauses, where the pause and
the human's later approval-triggered resume are naturally two separate
requests that may hit different locations. This SDK does not - and, given
KV's guarantees, cannot - promise strict read-after-write consistency here.
If your approval workflow can't tolerate that window, route a given
session's requests to a single Cloudflare location yourself (e.g. via
Durable Object-based request routing) or use a strongly-consistent store
instead of `AGENT_CHECKPOINTS`/KV. The same holds for sessions: two requests of
one session at the same moment can overwrite each other's turn, since a KV
read-modify-write is not atomic.

The KV-backed stores (`KVStore`, `KVCheckpointStore` and `CHECKPOINT_KV_BINDING`,
in `src/deploy/kvStore.ts`, `src/deploy/kvCheckpointStore.ts` and
`src/deploy/checkpointBinding.ts`) have no `node:*` references anywhere in their
dependency graph. The Worker runs the spec as a `createAgent()` agent, whose
Node-only imports (project instructions, the file session store, guardrail
patches, MCP over stdio) the build points at a shim that fails when used
(`src/deploy/shims/node.worker.ts`). The built `dist/worker.js` bundle is then
checked for `node:` and bare Node builtin specifiers as part of `loushy build`,
and fails the build if any are found. One exception: `ai` v7 and
`@ai-sdk/provider-utils` v5 look up `node:module`, `node:dns`,
`node:diagnostics_channel` and `node:async_hooks` at run time with
`process.getBuiltinModule()`, only when they detect Node, and fall back to
`fetch()` (or skip telemetry tracing) elsewhere. Those four ids are accepted as
the argument of such a call and nowhere else. The bundle is larger than a single-turn
Worker (about 1.7 MB raw, 340 KB gzip for a `mock` agent on `ai` v4; about 3.4 MB
raw, 630 KB gzip on `ai` v7): `loushy build` reports
its size, and `describe()` compares it to Cloudflare's script size limit.

## Custom targets

Targets are `DeploymentAdapter` objects (`scaffold`, `build`, `describe`)
registered by name with `registerAdapter()`; both are exported from the
package root.
