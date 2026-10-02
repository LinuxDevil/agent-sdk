# Installation

## Requirements

- Node.js **22.19 or newer** (`engines.node` in `package.json`, set by the `undici@8` dependency; `undici` is loaded only when the `http_request` or `web_fetch` tool makes a request, see [Optional peers](#optional-peers)).
- TypeScript is optional but recommended - the SDK ships full type
  definitions.

## Install the package

```bash
npm install @lousho/build-ai-agent ai zod
# or
pnpm add @lousho/build-ai-agent ai zod
# or
yarn add @lousho/build-ai-agent ai zod
```

`ai` (the Vercel AI SDK: `^4.3.19`, `^6.0.0` or `^7.0.0`) and `zod`
(`^3.25.76 || ^4.0.0`) are required peer dependencies. `ai` 5 is not supported.

Schemas from either zod major work everywhere the SDK takes one
(`defineTool({ input })`, structured `output`, MCP tools), including zod 4
schemas from `zod/v4` while zod 3.25 is installed and zod 3 schemas from
`zod/v3` on zod 4. A `defineTool` `input` can also be another
[Standard Schema](https://standardschema.dev) library's schema if it exposes its
JSON Schema (`~standard.jsonSchema`); the model needs a JSON Schema, so a
Standard Schema without one is rejected (use zod for those tools). `ai` 4's
provider packages declare zod 3 as a peer, so pair zod 4 with `ai` 6 or 7.

### Provider packages

Each real LLM provider is backed by an optional peer dependency, in the major
that pairs with your `ai` major. Install the pair from one row:

| `ai`      | OpenAI, OpenRouter: `@ai-sdk/openai` | Anthropic: `@ai-sdk/anthropic` | Ollama                                 |
| --------- | ------------------------------------ | ------------------------------ | -------------------------------------- |
| `^4.3.19` | `^0.0.42` (or `^1.0.0`)              | `^0.0.42` (or `^1.0.0`)        | `ollama-ai-provider@^1.2.0`            |
| `^6.0.0`  | `^3.0.0`                             | `^3.0.0`                       | `ollama-ai-provider-v2@^3.0.0` (zod 4) |
| `^7.0.0`  | `^4.0.0`                             | `^4.0.0`                       | `ollama-ai-provider-v2@^4.0.0` (zod 4) |

For example, on the current `ai` major:

```bash
npm install @lousho/build-ai-agent ai@^7.0.0 zod @ai-sdk/openai@^4.0.0
```

**Ollama on `ai` 6/7 needs zod 4.** `ollama-ai-provider-v2` (the Ollama package
for `ai` 6 and 7) declares `zod ^4` as a peer. The SDK accepts zod 4,
so install it with zod 4, for example
`npm install ai@^7.0.0 ollama-ai-provider-v2@^4.0.0 zod@^4.0.0`. With zod 3,
use `ai@^4.3.19` with `ollama-ai-provider@^1.2.0` (what
`lousho init --provider ollama` scaffolds).

Peers are loaded on demand: importing `@lousho/build-ai-agent` (or any of
its sub-entries) never loads a provider package, so you only need to install
the ones you use. Each provider package is loaded the first time that
provider makes a call; if it is missing, that call fails with a
`MissingPeerDependencyError` that carries the exact command to run, for the
`ai` major you have installed. With `ai` 4:

```bash
npm install @ai-sdk/openai@^0.0.42
```

```ts no-run
import { MissingPeerDependencyError, resolveProvider } from '@lousho/build-ai-agent';

const provider = resolveProvider('openai/gpt-4o-mini'); // needs OPENAI_API_KEY; does not load the peer
try {
  await provider.generate({ messages: [{ role: 'user', content: 'hello' }] });
} catch (error) {
  if (error instanceof MissingPeerDependencyError) {
    console.error(error.packageName, error.installCommand);
  }
}
```

### Optional peers

These packages are optional peers too. A project that never uses Docker
sandboxing, MCP, OpenTelemetry tracing, the React or Vue bindings, `lousho build`
or the `lousho init` questions installs none of them:

| Package                     | Range     | Enables                                                                                       | Install                                          |
| --------------------------- | --------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `dockerode`                 | `^5.0.1`  | Docker sandboxing: `SubprocessSandbox` (and `lousho doctor`'s Docker ping)                    | `npm install dockerode@^5.0.1`                   |
| `@modelcontextprotocol/sdk` | `^1.30.1` | MCP: `createAgent({ mcpServers })` / `connectMcp()`, `serveMcp()` and `lousho mcp`            | `npm install @modelcontextprotocol/sdk@^1.30.1`  |
| `@opentelemetry/api`        | `^1.9.1`  | OpenTelemetry tracing: `createOtelTraceExporter()` from `@lousho/build-ai-agent/otel`         | `npm install @opentelemetry/api@^1.9.1`          |
| `react`                     | `^18`, `^19` | The React bindings (`@lousho/build-ai-agent/react`)                                      | `npm install react`                              |
| `vue`                       | `^3`      | The Vue bindings (`@lousho/build-ai-agent/vue`)                                               | `npm install vue@^3`                             |
| `tsup`                      | `^8.0.0`  | `lousho build`, which bundles the agent for each target                                       | `npm install --save-dev tsup@^8.0.0`             |
| `prompts`                   | `^2.4.2`  | The interactive questions of `lousho init` (`lousho init --yes` and flags need nothing)       | `npm install prompts@^2.4.2`                     |

Like the provider packages, each is loaded on first use, never at import
time, and a missing one fails that call with a `MissingPeerDependencyError`
that names the feature and the exact command, for example:

```text
The optional package 'dockerode' is not installed, but Docker sandboxing (SubprocessSandbox) needs it. Run: npm install dockerode@^5.0.1
```

`npm create lousho-agent` installs `prompts` itself, so scaffolding with it
needs nothing extra. `lousho doctor` lists every optional peer, what it
enables and whether it is installed (a missing `dockerode` is an error only
when the agent spec uses a sandboxed tool).

`undici` and `yaml` stay regular dependencies. `yaml` parses agent specs,
`agent.yaml` files and skills, and Node has no built-in YAML parser. `undici`
is loaded on the first request of the `http_request` or `web_fetch` tool:
both connect through an undici `Agent` whose DNS lookup checks the address
and pins the connection to it, and `http_request` also scopes
`validateSSL: false` to that `Agent`. The global `fetch` can express neither.

## Entry points share code (ESM and CJS)

The package entries (`.`, `./hooks`, `./tools`, `./mcp`, ...) are built with code
splitting: they import shared chunks from `dist/`, so a class or singleton such
as `HookRegistry`, `SDKError` or `globalToolRegistry` is the same object whichever
entry you import it from, in ESM and in CJS. An ESM `import` and a CJS `require`
of the package in one process still load two separate copies (Node's dual-package
hazard), so a class from one is not `===` the other. `instanceof SDKError` and
`instanceof HookRegistry` are safe across the two copies (they check a
`Symbol.for` brand); for other classes, use one module format per process.

## Installing from a local build

To try an unreleased commit, build and pack the SDK from a checkout of this
repository, then install the tarball into your project - the same approach
`lousho init --sdk-path` uses for the projects it generates. This is verified
in CI by `npm run pack-smoke`, which installs the packed tarball into a fresh
project and loads every entry point, in ESM and CJS:

```bash
# in the SDK checkout
npm install
npm run build
npm pack --pack-destination /path/to/your-project

# in your project (peers come from the registry)
npm install ./lousho-build-ai-agent-<version>.tgz ai zod
```

To scaffold a new project the same way, from the checkout:
`node bin/lousho.js init ../my-agent --sdk-path .`.

`npm install github:LinuxDevil/agent-sdk` does **not** work: `dist/` is not in
git and the repository has no `prepare` build step, so the install has no
entry points.

## Scaffolding a new project

`lousho init` creates a ready-to-run project: `package.json` (ESM, depending
on this SDK by version range), a strict `tsconfig.json`, `src/agent.ts` calling
`createAgent({ model, instructions })` with an example `defineTool()` tool, an
offline `src/agent.test.ts` using `mockModel`, a `.env.example` naming your
provider's key variable, `.gitignore` and a README. It then installs the
dependencies and runs `git init`.

```bash
npx lousho init my-agent                 # or: npm create lousho-agent my-agent
npx lousho init my-agent --yes --provider anthropic --template tools --no-install
```

| Flag | Meaning |
| ---- | ------- |
| `--provider openai\|anthropic\|openrouter\|ollama` | Default: the provider whose API key variable is set, else `openai`. |
| `--template minimal\|tools\|yaml` | `minimal` (one tool), `tools` (three tools) or `yaml` (an `agent.yaml` spec run by `lousho dev`). Default `minimal`. |
| `--package-manager npm\|pnpm\|yarn\|bun` | Default: the one that launched the command (`npm_config_user_agent`), else `npm`. |
| `--yes`, `-y` | Never prompt; use defaults for anything not given. Prompts only appear on a terminal. |
| `--no-install`, `--no-git` | Skip installing dependencies / `git init`. |
| `--force` | Write into a directory that is not empty (otherwise `init` refuses). |
| `--sdk-path <dir\|tarball>` | For SDK development: depend on a checkout (it is `npm pack`ed) or a packed `.tgz` instead of the published version. Also read from `LOUSHO_SDK_PATH`. |

`create-lousho-agent` (`packages/create-lousho-agent`) is a thin wrapper that
runs `lousho init` with the same arguments.

## The `lousho` CLI

Installing the package also installs the `lousho` command: `init`, `doctor`,
`dev`, `chat`, `acp`, `add`, `mcp`, `eval`, `build` and `studio`. See
[CLI](./cli.md) for what each one does and its flags. Building needs `tsup`,
an optional peer (see the table above): `npm install --save-dev tsup`.

## Troubleshooting: lousho doctor

Run `npx lousho doctor` right after installing. It prints one line per check
with a status (`ok`, `warn`, `FAIL`), what it found, and, for anything that is
not ok, the command to run or the setting to change:

```text
lousho doctor

[ ok ] Node.js: v22.19.0 satisfies >=22.19.0
[ ok ] Required peer ai: 7.0.0 satisfies ^7.0.0
[FAIL] Required peer zod: not installed
       fix: npm install zod@^4.0.0
[ ok ] Provider package @ai-sdk/openai: 4.0.0 installed
[warn] Provider package @ai-sdk/anthropic: not installed (optional)
       fix: npm install @ai-sdk/anthropic@^4.0.0
[warn] openai (OPENAI_API_KEY): not set
       fix: Set OPENAI_API_KEY in your environment, e.g. export OPENAI_API_KEY=<your key>
[warn] Default provider for createAgent(): none configured (createAgent() needs a model, a provider instance, or an env var)
       fix: Set LOUSHO_MODEL (e.g. openai/gpt-4o-mini) or one of the API key variables above.
[ ok ] Docker: daemon not reachable (only needed for sandboxed tools; none configured)

4 ok, 3 warnings, 1 failure
```

What it checks:

1. Your Node version against the package's `engines.node`.
2. The required peers `ai` and `zod`: installed, and within the SDK's
   `peerDependencies` range (resolved from the current directory).
3. The optional provider packages (`@ai-sdk/openai`, `@ai-sdk/anthropic`, and
   `ollama-ai-provider` on `ai` 4 or `ollama-ai-provider-v2` on `ai` 6/7), with
   the `npm install` command for each missing one. A provider package that does
   not pair with the installed `ai` (for example `ai` 7 with `@ai-sdk/openai`
   1.x) is flagged with the version to install instead.
4. Whether each provider's API key variable is set. Only the variable name and
   `set` / `not set` are printed, never the value. It also shows which
   provider `createAgent()` would pick by default with your environment.
5. With a spec path (`lousho doctor agent.yaml`): the spec is validated with
   field paths for every error, its provider package and key are checked
   (missing ones become failures), its `tools` must be built-in tools, and any
   `mcpServers` command must be resolvable.
6. Ollama reachability, only when the spec uses Ollama or `OLLAMA_HOST` is set.
7. Docker availability, a warning only when the spec uses a sandboxed tool.

The exit code is `1` if any check fails and `0` otherwise (warnings do not
fail), so it can gate CI. Add `--json` for machine-readable output. Colour is
used only when stdout is a terminal and `NO_COLOR` is unset.

For problems that are not about installing, see [Troubleshooting](./troubleshooting.md).

Next: [Quick Start](./quick-start.md).
