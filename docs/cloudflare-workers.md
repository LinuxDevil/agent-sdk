# Cloudflare Workers

`npx lousho build --target=cloudflare-worker --agent=agent.yaml` generates a module Worker (`worker.ts`), a `wrangler.toml` and a bundle, `dist/worker.js`, that the build checks for `node:` imports. It needs `tsup` and `wrangler` installed, and it takes an [agent spec file](./configuration.md) or an [agent directory](./agent-directories.md) (`npx lousho build ./my-agent --target=cloudflare-worker`). The Worker serves the same [HTTP API](./deployment.md#http-api) as the other targets. This target has the tightest limits of the three, so they come first.

## What works and what does not

<!-- LIMITS TABLE: the one place that states what the Worker target supports. Update it when the target gains a provider, a tool or a feature. -->

| Feature | Cloudflare Worker | `node-server` / `docker` |
| ------- | ----------------- | ------------------------ |
| Agent spec files | yes | yes |
| [Agent directories](./agent-directories.md) | yes: config, `instructions.md`, `tools/`, `skills/`; not `subagents/`, `schedules/`, `channels/`, `memory/` or `projectInstructions` | yes, all of it |
| Providers | `mock`, `openai`, `anthropic`, `openrouter` | `mock`, `openai`, `anthropic`, `ollama`, `openrouter` |
| Built-in tools | `current-date`, `day-name`, `http` (listed host names only, from the `LOUSHO_HTTP_ALLOW` binding) | all, including `http` and `web-fetch` |
| Tools written in TypeScript | yes, in an agent directory: no Node builtins, and from `@lousho/build-ai-agent` only the names listed under [Agent directories on a Worker](#build-and-deploy) | yes, in an agent directory |
| Sandboxed tool execution | no (the build swaps the sandbox for a shim that fails when used) | yes |
| MCP servers over stdio | no (the child process cannot start; the shim fails when used) | yes |
| [Code mode](./code-mode.md) (`codeMode`) | no (the build swaps QuickJS for a shim that fails the run at its start) | yes |
| MCP servers over HTTP | not verified | yes |
| Sessions, checkpoints, approvals | one KV namespace, `AGENT_CHECKPOINTS` (eventually consistent) | memory, files, SQLite |
| Schedules | cron triggers only, in UTC, five fields, one-minute granularity | full cron expressions, with a time zone |
| Bundle | `lousho build` checks for Node builtins and reports its size | not checked |
| [Route auth](./auth.md) | the `LOUSHO_API_TOKEN` bearer token only | the token, or an ordered list (`jwt()`, `oidc()`, `basic()`, ...) from an agent directory's `auth.ts` |

`lousho build` rejects a spec whose provider or tool is not in the Worker column, and an agent directory with a folder or setting the Worker column leaves out, with a `LOUSHO_DEPLOY_FAILED` error that names it and suggests `--target=node-server` or `--target=docker`.

### Providers and tools

The reasons behind the provider and tool rows:

- providers: `mock`, `openai`, `anthropic` and `openrouter`. The real
  providers are built on the Vercel `ai` SDK's `generateText`/`streamText`
  plus `@ai-sdk/openai`/`@ai-sdk/anthropic` (`openrouter` is
  `@ai-sdk/openai` pointed at `https://openrouter.ai/api/v1`), which are
  pure `fetch()`/Web-standard implementations with no `node:*` imports, so
  they bundle and run on Workers cleanly; the build's leak check verifies
  every bundle. `ollama` is **not** supported here: it defaults to a local
  `http://localhost:11434` endpoint that a Worker can't reach; use
  `node-server` or `docker` for it;
- tools: `current-date`, `day-name` and `http`. `web-fetch` is **not**
  supported. On Node, `http` and `web-fetch` refuse private destinations
  with a DNS lookup of their own (`node:dns` inside an `undici` `Agent`)
  that checks every address a host resolves to and connects to the address
  it checked, so DNS rebinding cannot get past the check. A Worker has
  neither: its `fetch()` resolves names inside Cloudflare's network and
  gives no hook to see or pin the address. What a Worker can check is the
  URL (scheme, host name, an IP-literal host); what it cannot guarantee is
  where a host name connects, so a name that resolves to an internal
  address would not be caught. So the Worker's `http` (the same
  `http_request` tool name and input as on Node) is a different tool: it
  reaches only the host names you list. On the first URL and on every
  redirect it refuses:
  - any scheme but `http:` and `https:`;
  - an IP-address host (`http://10.0.0.1/`, `http://[::1]/`), even a listed
    one: there is no address check, so only names are allowed;
  - a host that does not match the `LOUSHO_HTTP_ALLOW` binding, a
    comma-separated list of host names (`api.github.com`) and `*.` wildcards
    (`*.example.com`, which matches subdomains only, not `example.com`).
    Unset or empty, every request is refused (fail closed); an entry that is
    not a host name fails every request with an error naming it.

  A model therefore cannot pick an arbitrary host, or a DNS-rebinding one,
  because only the names you listed pass; a listed name is trusted wherever
  it resolves, so list only hosts you control or trust. TLS is always
  validated (there is no `validateSSL` option) and the tool runs without a
  sandbox. A tool of your own that calls `fetch()` in a Worker gets no SSRF
  protection from the SDK.

## Build and deploy

The build generates a module Worker (`export default { fetch }`) and bundles it as a
browser-platform ES module; the build fails if any `node:` import ends up in
`dist/worker.js`. `wrangler.toml` points `main` at `dist/worker.js` with
`no_bundle = true`, so exactly the verified bundle is uploaded. It builds and
runs with `ai` v4 (the default install) or `ai` v7 (with
`@ai-sdk/openai`/`@ai-sdk/anthropic` v4) installed, with no compatibility
flag (no `nodejs_compat`):

```bash
cd .lousho/build/cloudflare-worker
npx wrangler dev       # local workerd runtime
npx wrangler deploy    # requires a Cloudflare account (`wrangler login`)
```

Provider API keys are read from Worker bindings named `<TYPE>_API_KEY` (for example
`wrangler secret put OPENAI_API_KEY`, `wrangler secret put ANTHROPIC_API_KEY` or
`wrangler secret put OPENROUTER_API_KEY`). The peer packages (`@ai-sdk/openai` for
`openai` and `openrouter`, `@ai-sdk/anthropic` for `anthropic`, and `ai`) must be
installed alongside `@lousho/build-ai-agent` for `lousho build` to bundle them.

**Agent directories on a Worker.** A Worker has no file system and cannot import
a file by path at run time, so the build reads the
[agent directory](./agent-directories.md) on Node and writes `agent.module.ts`:
a static import of each `tools/*.ts` file (and of an `agent.ts` / `agent.js`
config), with `instructions.md`, a JSON/YAML config and the skills copied in as
JSON. The Worker builds the agent with the same rules as `resolveAgentDir()`
(config keys, tool exports, duplicate tool names):

```bash
npx lousho build ./my-agent --target=cloudflare-worker
cd .lousho/build/cloudflare-worker && npx wrangler deploy
```

- The config's `model` must name a provider of the table above (`"model": "openai/gpt-4o-mini"`),
  with its key in the `OPENAI_API_KEY` binding; or `agent.ts` sets `provider` to an instance.
  The `vendor/` model prefix chooses the provider; with OpenRouter use
  `openrouter/<vendor>/<model>` (e.g. `openrouter/openai/gpt-4o-mini`).
  There is no environment to pick a default model from, so a directory without either is rejected.
- A JSON/YAML config is checked by `lousho build`; an `agent.ts` config is checked when the
  Worker starts, so `wrangler deploy` reports the problem.
- `subagents/`, `schedules/`, `channels/`, `memory/` and `projectInstructions` are rejected,
  naming the folder or key. Use `node-server` or `docker` for them.
- Tool files are bundled from where they are, so their relative imports and their
  `node_modules` resolve as in development. A tool that imports a Node builtin fails the
  build's leak check, which names the file.
- In a tool or `agent.ts`, `@lousho/build-ai-agent` is a Worker-safe subset of the package:
  `defineTool`, `isDefinedTool`, `always`, `never`, `once`, `defineSkill`, `createMockProvider`,
  `MockLLMProvider`, `OpenAIProvider`, `AnthropicProvider`, `OpenRouterProvider`, `fromAiSdk`,
  `LLMProviderRegistry`, `textOf`, `SDKError`, `ConfigurationError`, `ToolExecutionError` and
  `ValidationError`. Importing another name fails the build with this list; type-only imports
  work for every type.

What a tool can reach on a Worker: a tool file runs in the Worker's isolate, not in a
sandbox, with the same rights as the rest of the Worker. It can `fetch()` any host
(`LOUSHO_HTTP_ALLOW` restricts only the built-in `http` tool, not your code), and it
shares the isolate's memory with every session the isolate serves (without
`AGENT_CHECKPOINTS`, that includes their sessions). The SDK does not hand a tool the
Worker's `env` (the provider API keys, `LOUSHO_API_TOKEN`, the KV namespace), and the
build does not resolve `cloudflare:` imports, so `import { env } from 'cloudflare:workers'`
fails the build; but code in one isolate is not a security boundary. Deploy only tool
code you would trust with those bindings.

## Bindings

The Worker serves the [HTTP API](./deployment.md#http-api): `GET /health`, `POST /chat`
streamed as SSE (`ReadableStream`), `GET /chat/:sessionId`, the approvals
endpoint and the deprecated `{ "message" }` body. Its bindings:

| Binding | Kind | What it does |
| ------- | ---- | ------------ |
| `LOUSHO_API_TOKEN` | secret (`npx wrangler secret put LOUSHO_API_TOKEN`) | Makes every route except `/health` require `Authorization: Bearer <token>` (constant-time compare, `401` JSON otherwise). Without it the Worker is open to anyone who has its URL, so **set it before you deploy**. |
| `AGENT_CHECKPOINTS` | KV namespace | Holds sessions, checkpoints and paused approvals, in one namespace, as `KVStore` (below). Without it they live in the memory of one isolate, which Cloudflare recycles at will: fine for trying a deploy out, not for production. |
| `LOUSHO_HTTP_ALLOW` | variable (`[vars]` in `wrangler.toml`) | The host names the `http` tool may reach, comma-separated: `api.github.com`, or `*.example.com` for subdomains only. Unset or empty, every `http` request is refused. See [Providers and tools](#providers-and-tools). |

`wrangler.toml` is scaffolded with the `[[kv_namespaces]]` block for
`AGENT_CHECKPOINTS` commented out, with the commands to create the namespace
(`npx wrangler kv namespace create AGENT_CHECKPOINTS`, plus a `--preview`
variant) and where to paste the resulting ids. Uncomment it and fill in the ids.
When the spec lists `http`, it also has a commented `[vars]` block for
`LOUSHO_HTTP_ALLOW`; uncomment it and list your hosts:

```toml
[vars]
LOUSHO_HTTP_ALLOW = "api.github.com,*.example.com"
```

```bash
cd .lousho/build/cloudflare-worker
npx wrangler secret put LOUSHO_API_TOKEN
npx wrangler secret put OPENAI_API_KEY
npx wrangler deploy
curl -N https://<your-worker>.workers.dev/chat \
  -H "Authorization: Bearer $LOUSHO_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "sessionId": "alice", "input": "Hello" }'
```

## Sessions, checkpoints and approvals

`KVStore(kvBinding, { prefix?, ttl?, historyLimit?, tokenKey? })` is the `AgentStore` the
generated Worker builds from the binding. A hand-written Worker imports it from
the `/kv` subpath, which has no `node:*` import anywhere in its graph, with the
binding typed as `KVBinding` (the `get`/`put`/`delete` part of Cloudflare's
`KVNamespace`, so `@cloudflare/workers-types` is not needed):

```ts
import { createAgent } from '@lousho/build-ai-agent';
import { KVStore, type KVBinding } from '@lousho/build-ai-agent/kv';

interface Env {
  AGENT_KV: KVBinding;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const agent = createAgent({ provider, store: new KVStore(env.AGENT_KV) });
    const { sessionId, input } = (await request.json()) as { sessionId: string; input: string };
    const { text } = await agent.session({ id: sessionId }).send(input);
    return Response.json({ text });
  },
};
```

`/kv` also exports `KVCheckpointStore` (checkpoints only) and
`CHECKPOINT_KV_BINDING` (`'AGENT_CHECKPOINTS'`, the binding name the generated
Worker reads). `KVStore`'s keys, with an optional `prefix` before each:

| Key | Value |
| --- | ----- |
| `sessions/<id>` | The transcript as JSON (image and file bytes as `{ "$bytes": "<base64>" }`, like `FileSessionStore`). |
| `checkpoints/<id>` | The `Checkpoint` of a durable run or session turn (`KVCheckpointStore`, with its history under `checkpoints/<id>#history`). |
| `approvals/<id>` | A paused approval and the snapshot that resumes it (deleted when it is decided). |
| `oauth/tokens/<key>`, `oauth/pending/<state>` | OAuth tokens and pending sign-ins, encrypted with `tokenKey` (the `LOUSHO_TOKEN_KEY` secret in the generated Worker); see [OAuth](oauth.md#token-storage). |

`ttl: { sessions?, checkpoints?, approvals? }` (seconds, KV accepts 60 or more)
makes each kind of record expire that long after its last write; by default
records are kept until deleted.

An approval that pauses a turn on one request can be decided by a later request
on another isolate: the checkpointed session names its pending approval, and the
approvals endpoint continues it from KV. The continuation streams as a normal
resumed run: the decided call's `tool.resume` and `tool.done` (`tool.error` for
a rejection), then the turn's events, ending with a `run.done` that carries
the final text.

The deprecated `POST /chat { "message", "sessionId"? }` keeps its earlier
behaviour on Workers: with a `sessionId` the run is checkpointed to
`checkpoints/<sessionId>` after each tool result and rehydrated by a later
request that reuses the `sessionId` (after a crash or a recycled isolate).

## Scheduled runs

Cron triggers in the spec (`triggers: [{ type: 'cron', cron: '0 9 * * MON', input: '...' }]`)
become `[triggers] crons = [...]` in `wrangler.toml`, and the generated Worker
exports a `scheduled()` handler that runs them as agent turns (session
`schedule-<name>`, see [Schedules](schedules.md#on-cloudflare-workers)). Cloudflare
evaluates the expressions in **UTC** with a granularity of one minute; the
build rejects a `timezone`, a seconds field, an `@daily` shortcut or a numeric
day-of-week (`LOUSHO_SCHEDULE_INVALID`).

In a Worker you write yourself, wire an agent defined in code with
`handleScheduled(agent, schedules, controller, ctx)` (exported from the package
root — the `@lousho/build-ai-agent/deploy-runtime-worker` specifier in the
generated code is a virtual one that only `lousho build`'s bundler resolves; do
not import it yourself). It runs the schedules whose
`cron` equals `controller.cron` inside `ctx.waitUntil()` and never throws; list
the same expressions under `[triggers] crons` yourself. Give the agent a store
— without one, a scheduled run's `schedule-<name>` session lives in one
isolate's memory and is gone when it is recycled:

```ts
import { createAgent, createMockProvider, defineSchedule, handleScheduled } from '@lousho/build-ai-agent';
import type { ScheduledContext, ScheduledController } from '@lousho/build-ai-agent';
import { KVStore, type KVBinding } from '@lousho/build-ai-agent/kv';

interface Env {
  AGENT_CHECKPOINTS: KVBinding;
}

const schedules = [defineSchedule({ name: 'weekly', cron: '0 9 * * MON', prompt: 'Summarise last week.' })];

export default {
  scheduled: (controller: ScheduledController, env: Env, ctx: ScheduledContext) => {
    const agent = createAgent({
      instructions: 'You write reports.',
      provider: createMockProvider(),
      store: new KVStore(env.AGENT_CHECKPOINTS), // keeps sessions, checkpoints and paused approvals
    });
    return handleScheduled(agent, schedules, controller, ctx);
  },
};
```

## Consistency

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

## Bundle size and Node builtins

The KV-backed stores (`KVStore`, `KVCheckpointStore` and `CHECKPOINT_KV_BINDING`,
exported from `@lousho/build-ai-agent/kv`) have no `node:*` references anywhere
in their dependency graph. The Worker runs the spec as a `createAgent()` agent, whose
Node-only imports (project instructions, the file session store, guardrail
patches, MCP over stdio) the build points at a shim that fails when used
(`src/deploy/shims/node.worker.ts`). The built `dist/worker.js` bundle is then
checked for `node:` and bare Node builtin specifiers as part of `lousho build`,
and fails the build if any are found; when one was imported (by an agent directory's tool, say), the error names the importing file. One exception: `ai` v7 and
`@ai-sdk/provider-utils` v5 look up `node:module`, `node:dns`,
`node:diagnostics_channel` and `node:async_hooks` at run time with
`process.getBuiltinModule()`, only when they detect Node, and fall back to
`fetch()` (or skip telemetry tracing) elsewhere. Those four ids are accepted as
the argument of such a call and nowhere else. The bundle is larger than a single-turn
Worker (about 1.7 MB raw, 340 KB gzip for a `mock` agent on `ai` v4; about 3.4 MB
raw, 630 KB gzip on `ai` v7): `lousho build` reports
its size, and `describe()` compares it to Cloudflare's script size limit.
