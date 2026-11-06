<div align="center">
  <a href="https://lousho.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/lousho-dark.svg">
      <img alt="Lousho logo" src=".github/assets/lousho.svg" height="128">
    </picture>
  </a>

# Lousho — TypeScript AI agent SDK

[![npm](https://img.shields.io/npm/v/lousho)](https://www.npmjs.com/package/lousho)
![CI](https://github.com/LinuxDevil/agent-sdk/actions/workflows/ci.yml/badge.svg?branch=main)
[![Docs](https://img.shields.io/badge/docs-lousho.com-0F9D74)](https://lousho.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

Open-source TypeScript SDK for agents that run in your own Node process: tool calling, MCP, sessions that survive a restart, human approvals, and OpenTelemetry. No hosted runtime.

## Installation

Requires Node.js 22.19 or newer.

```bash
npm create lousho my-agent
cd my-agent
cp .env.example .env
npm run dev
```

Put your API key in `.env` before `npm run dev`. `npm test` runs offline.

To add it to an existing project:

```bash
npm install lousho ai@^7.0.0 zod @ai-sdk/openai@^4.0.0
```

See [Installation](docs/installation.md#provider-packages) for other providers. `npx lousho doctor` checks your setup and prints a fix for anything missing.

## Quickstart

This file uses top-level `await`, so it must be an ES module (`.mts`, or `"type": "module"` in `package.json`). Set `OPENAI_API_KEY` to run it.

```ts
import { createAgent, defineTool } from 'lousho';
import { z } from 'zod';

const getWeather = defineTool({
  name: 'get_weather',
  description: 'Current weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21, sky: 'sunny' }),
});

const agent = createAgent({
  model: 'openai/gpt-4.1-mini',
  instructions: 'You are a travel assistant. Check the weather before giving advice.',
  tools: [getWeather],
});

const { text } = await agent.send('What should I wear in Lisbon today?');
console.log(text);
```

An agent can also be a folder, which you run with `npx lousho dev ./my-agent`:

```text
my-agent/
├── agent.json          # Optional: model, permissions, limits
├── instructions.md     # The system prompt
├── tools/              # defineTool() tools
│   └── get_weather.ts
└── skills/             # Instructions loaded on demand
```

Loading a folder runs its code, so only load ones you trust. See [Agent directories](docs/agent-directories.md).

## Features

- **Evals you can run in CI**: `lousho eval` records a real run once, replays it with no network or API key, and reports when the tool-call trajectory drifts. [Evals](docs/evals.md)
- **Approvals**: `needsApproval` pauses a run, and another request or process can resume it. [Approvals](docs/approvals.md)
- **Durable execution**: `agent.resume()` finishes a crashed run without redoing finished tools, on memory, file, SQLite or Cloudflare KV stores. [Durable execution](docs/durable-execution.md)
- **MCP**: connect to MCP servers, or serve your agent as one. [MCP](docs/mcp.md)
- **Multi-agent**: [sub-agents](docs/sub-agents.md) that run in parallel, and [handoffs](docs/handoffs.md) to specialists.
- **UI**: bindings for [React](docs/react.md), [Vue](docs/vue.md) and [Svelte](docs/svelte.md), plus [AI SDK `useChat`](docs/ai-sdk-ui.md) and [Next.js routes](docs/nextjs.md).
- **Tracing**: OpenTelemetry GenAI spans and a local trace viewer. [Observability](docs/observability.md)
- **Deployment**: `lousho build` targets a Node server, Docker or Cloudflare Workers. [Deployment](docs/deployment.md)
- **Coding agents**: workspace tools, permission rules and starter kits from `lousho add`. [Build a coding agent](docs/build-a-coding-agent.md)
- **Agent Forge**: `lousho studio` opens a local visual canvas, run debugger and chat. [Agent Forge](docs/agent-forge.md)

## Documentation

The full guides are at [lousho.com](https://lousho.com), in English and Arabic. Good places to start: [Quick Start](docs/quick-start.md), [Tools](docs/tools.md), [Providers](docs/providers.md), [CLI](docs/cli.md) and [Troubleshooting](docs/troubleshooting.md).

Coding agents can read the docs from `node_modules/lousho/docs`, indexed by [`llms.txt`](llms.txt). The repo also has every page in one file, [`llms-full.txt`](llms-full.txt).

## Examples

Most examples run offline with a mock provider. The [examples index](examples/README.md) has the full list and how to run each one. A few to start with:

- [ops-pipeline](examples/ops-pipeline): monitor alert, Slack button, human approval, fixer agent, gated GitHub PR
- [coding-harness](examples/coding-harness): a coding agent with checkpoints, permission rules and a loop guard
- [deep-research](examples/deep-research): parallel researcher sub-agents and a cited report
- [support-desk](examples/support-desk): triage handoffs and an approval-gated refund tool

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the checks a pull request must pass. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

MIT © [Lousho Team](LICENSE)
