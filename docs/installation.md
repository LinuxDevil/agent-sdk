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

> **Current limitation:** the package's root entry point
> (`@loushy/build-ai-agent`) loads every provider module when it is
> imported, so today all three provider packages must be installed even if
> you only use one provider (or only the built-in mock provider):
>
> ```bash
> npm install @ai-sdk/openai@^0.0.42 @ai-sdk/anthropic@^0.0.42 ollama-ai-provider@^1.2.0
> ```

## Installing from a local build

To try an unreleased version, build and pack the SDK from a checkout of this
repository, then install the tarball into your project - the same approach
`create-loushy-agent` uses for the projects it generates:

```bash
# in the SDK checkout
npm install
npm run build
npm pack --pack-destination /path/to/your-project

# in your project
npm install ./loushy-build-ai-agent-<version>.tgz ai zod
```

## Scaffolding a new project

`packages/create-loushy-agent` in this repository scaffolds a ready-to-build
project (`package.json`, `tsconfig.json`, `src/agent.ts` calling
`createAgent()`, and a `.env.example` naming your provider's credential
variable):

```bash
# from a checkout of this repository
cd packages/create-loushy-agent && npm install && npm run build && cd ../..
node packages/create-loushy-agent/bin/cli.js --name=my-agent --provider=openai --yes
```

## The `loushy` CLI

Installing the package also installs the `loushy` command:

- `loushy dev <spec.yaml|spec.json>` - local dev server with a chat UI and hot
  reload (see [Configuration](./configuration.md)).
- `loushy build --target=<target> --agent=<spec>` - build a deployable
  artifact (see [Deployment](./deployment.md)). Building requires `tsup`
  (`npm install --save-dev tsup`).

Next: [Quick Start](./quick-start.md).
