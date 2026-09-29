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

Every target serves the same HTTP API as `loushy dev`:

- `GET /health` - `200 ok`
- `POST /chat` - JSON `{ "message": "..." }` in, the agent's
  `ExecutionResult` (from `AgentExecutor.execute()`) out. Bodies over 1MB
  are rejected with `413`.

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
`PORT`, or defaults to `3000`. Provider credentials are read from the same
environment variables as everywhere else (`OPENAI_API_KEY`, ...).

## `docker`

Reuses the `node-server` scaffold and bundle and adds a `Dockerfile` based
on `node:20-slim` that copies `dist/` and runs `node dist/server.js` on port
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
`no_bundle = true`, so exactly the verified bundle is uploaded:

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
  DNS-rebinding gap), then pins TLS settings per request via a dedicated
  `undici` `Agent`. Workers' native `fetch()` has no equivalent hook to
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

### Durable execution (pause/resume) on Workers

A Worker's request lifetime is too short-lived for an in-memory or
filesystem-backed `CheckpointStore` (see
[Configuration](./configuration.md) / `src/execution/checkpoint.ts` for
what `CheckpointStore` is and why a run needs one to survive a crash or an
approval-gate pause). To make that work on this target, `loushy build
--target=cloudflare-worker` supports an **opt-in, KV-backed
`CheckpointStore`**:

1. Create a Workers KV namespace and bind it to your Worker under the name
   `AGENT_CHECKPOINTS` - `wrangler.toml` is scaffolded with a commented-out
   `[[kv_namespaces]]` block spelling out the exact commands
   (`npx wrangler kv namespace create AGENT_CHECKPOINTS`, plus a `--preview`
   variant) and where to paste the resulting ids. Uncomment it and fill in
   the ids to opt in.
2. `POST /chat` accepts an optional `sessionId` string alongside `message`.
   When a request includes `sessionId` **and** the Worker has an
   `AGENT_CHECKPOINTS` binding configured, that request's run is
   checkpointed to KV after each tool result and rehydrated from KV on a
   later request that reuses the same `sessionId` (e.g. after a crash, a
   redeploy, or the isolate simply being recycled between requests) -
   exactly the `sessionId`+`CheckpointStore` mechanism the rest of this SDK
   already uses (see `AgentExecutor.execute()`), just backed by KV instead
   of the filesystem. A request with `sessionId` but **no** KV binding
   configured still works normally - checkpointing is silently skipped,
   the same as calling `AgentExecutor.execute()` with no `checkpointStore`
   at all.
3. Without a `sessionId`, requests behave exactly as before this feature
   existed - durable execution is entirely opt-in.

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
instead of `AGENT_CHECKPOINTS`/KV.

The KV-backed store itself
(`KVCheckpointStore`/`checkpointStoreFromEnv()`/`CHECKPOINT_KV_BINDING`, in
`src/deploy/kvCheckpointStore.ts` and `src/deploy/runtime.worker.ts`) has no
`node:*` references anywhere in its dependency graph, verified the same way
as the rest of this target: the built `dist/worker.js` bundle is grepped
for `node:` specifiers as part of `loushy build`, and fails the build if
any are found.

## Custom targets

Targets are `DeploymentAdapter` objects (`scaffold`, `build`, `describe`)
registered by name with `registerAdapter()`; both are exported from the
package root.
