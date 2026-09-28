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

## Custom targets

Targets are `DeploymentAdapter` objects (`scaffold`, `build`, `describe`)
registered by name with `registerAdapter()`; both are exported from the
package root.
