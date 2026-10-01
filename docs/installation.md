# Installation

## Requirements

- Node.js **22.19 or newer** (`engines.node` in `package.json`; the built-in `http` tool depends on `undici@8`, which needs it).
- TypeScript is optional but recommended - the SDK ships full type
  definitions.

## Install the package

```bash
npm install @loushy/build-ai-agent ai zod
# or
pnpm add @loushy/build-ai-agent ai zod
# or
yarn add @loushy/build-ai-agent ai zod
```

`ai` (the Vercel AI SDK, `^4.3.19`) and `zod` (`^3.25.76`) are required peer
dependencies.

### Provider packages

Each real LLM provider is backed by an optional peer dependency:

| Provider   | Package              | Range     |
| ---------- | -------------------- | --------- |
| OpenAI     | `@ai-sdk/openai`     | `^0.0.42` |
| OpenRouter | `@ai-sdk/openai`     | `^0.0.42` |
| Anthropic  | `@ai-sdk/anthropic`  | `^0.0.42` |
| Ollama     | `ollama-ai-provider` | `^1.2.0`  |

Peers are loaded on demand: importing `@loushy/build-ai-agent` (or any of
its sub-entries) never loads a provider package, so you only need to install
the ones you use. Each provider package is loaded the first time that
provider makes a call; if it is missing, that call fails with a
`MissingPeerDependencyError` that carries the exact command to run:

```bash
npm install @ai-sdk/openai@^0.0.42
```

```ts no-run
import { MissingPeerDependencyError, resolveProvider } from '@loushy/build-ai-agent';

const provider = resolveProvider('openai/gpt-4o-mini'); // needs OPENAI_API_KEY; does not load the peer
try {
  await provider.generate({ messages: [{ role: 'user', content: 'hello' }] });
} catch (error) {
  if (error instanceof MissingPeerDependencyError) {
    console.error(error.packageName, error.installCommand);
  }
}
```

The same applies to the dependencies the SDK ships with but only loads when a
feature needs them: `undici` (the built-in `http` tool), `dockerode`
(`SubprocessSandbox`) and `@modelcontextprotocol/sdk` (`serveMcp`).

## Installing from a local build

To try an unreleased version, build and pack the SDK from a checkout of this
repository, then install the tarball into your project - the same approach
`loushy init --sdk-path` uses for the projects it generates:

```bash
# in the SDK checkout
npm install
npm run build
npm pack --pack-destination /path/to/your-project

# in your project
npm install ./loushy-build-ai-agent-<version>.tgz ai zod
```

## Scaffolding a new project

`loushy init` creates a ready-to-run project: `package.json` (ESM, depending
on this SDK by version range), a strict `tsconfig.json`, `src/agent.ts` calling
`createAgent({ model, instructions })` with an example `defineTool()` tool, an
offline `src/agent.test.ts` using `mockModel`, a `.env.example` naming your
provider's key variable, `.gitignore` and a README. It then installs the
dependencies and runs `git init`.

```bash
npx loushy init my-agent                 # or: npm create loushy-agent my-agent
npx loushy init my-agent --yes --provider anthropic --template tools --no-install
```

| Flag | Meaning |
| ---- | ------- |
| `--provider openai\|anthropic\|openrouter\|ollama` | Default: the provider whose API key variable is set, else `openai`. |
| `--template minimal\|tools\|yaml` | `minimal` (one tool), `tools` (three tools) or `yaml` (an `agent.yaml` spec run by `loushy dev`). Default `minimal`. |
| `--package-manager npm\|pnpm\|yarn\|bun` | Default: the one that launched the command (`npm_config_user_agent`), else `npm`. |
| `--yes`, `-y` | Never prompt; use defaults for anything not given. Prompts only appear on a terminal. |
| `--no-install`, `--no-git` | Skip installing dependencies / `git init`. |
| `--force` | Write into a directory that is not empty (otherwise `init` refuses). |
| `--sdk-path <dir\|tarball>` | For SDK development: depend on a checkout (it is `npm pack`ed) or a packed `.tgz` instead of the published version. Also read from `LOUSHY_SDK_PATH`. |

`create-loushy-agent` (`packages/create-loushy-agent`) is a thin wrapper that
runs `loushy init` with the same arguments.

## The `loushy` CLI

Installing the package also installs the `loushy` command:

- `loushy init [dir]` - scaffold a new project (see above).
- `loushy dev <spec.yaml|spec.json>` - local dev server with a chat UI and hot
  reload (see [Configuration](./configuration.md)).
- `loushy build --target=<target> --agent=<spec>` - build a deployable
  artifact (see [Deployment](./deployment.md)). Building requires `tsup`
  (`npm install --save-dev tsup`).

- `loushy doctor [agent.yaml|json] [--json]` - diagnose your setup (see below).

## Troubleshooting: loushy doctor

Run `npx loushy doctor` right after installing. It prints one line per check
with a status (`ok`, `warn`, `FAIL`), what it found, and, for anything that is
not ok, the command to run or the setting to change:

```text
loushy doctor

[ ok ] Node.js: v22.19.0 satisfies >=22.19.0
[ ok ] Required peer ai: 4.3.19 satisfies ^4.3.19
[FAIL] Required peer zod: not installed
       fix: npm install zod@^3.25.76
[ ok ] Provider package @ai-sdk/openai: 0.0.42 installed
[warn] Provider package @ai-sdk/anthropic: not installed (optional)
       fix: npm install @ai-sdk/anthropic@^0.0.42
[warn] openai (OPENAI_API_KEY): not set
       fix: Set OPENAI_API_KEY in your environment, e.g. export OPENAI_API_KEY=<your key>
[warn] Default provider for createAgent(): none configured (createAgent() needs a model, a provider instance, or an env var)
       fix: Set LOUSHY_MODEL (e.g. openai/gpt-4o-mini) or one of the API key variables above.
[ ok ] Docker: daemon not reachable (only needed for sandboxed tools; none configured)

4 ok, 3 warnings, 1 failure
```

What it checks:

1. Your Node version against the package's `engines.node`.
2. The required peers `ai` and `zod`: installed, and within the SDK's
   `peerDependencies` range (resolved from the current directory).
3. The optional provider packages (`@ai-sdk/openai`, `@ai-sdk/anthropic`,
   `ollama-ai-provider`), with the `npm install` command for each missing one.
4. Whether each provider's API key variable is set. Only the variable name and
   `set` / `not set` are printed, never the value. It also shows which
   provider `createAgent()` would pick by default with your environment.
5. With a spec path (`loushy doctor agent.yaml`): the spec is validated with
   field paths for every error, its provider package and key are checked
   (missing ones become failures), its `tools` must be built-in tools, and any
   `mcpServers` command must be resolvable.
6. Ollama reachability, only when the spec uses Ollama or `OLLAMA_HOST` is set.
7. Docker availability, a warning only when the spec uses a sandboxed tool.

The exit code is `1` if any check fails and `0` otherwise (warnings do not
fail), so it can gate CI. Add `--json` for machine-readable output. Colour is
used only when stdout is a terminal and `NO_COLOR` is unset.

Next: [Quick Start](./quick-start.md).
