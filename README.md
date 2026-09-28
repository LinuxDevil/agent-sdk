# @loushy/build-ai-agent

![CI](https://github.com/LinuxDevil/agent-sdk/actions/workflows/ci.yml/badge.svg)

<div align="center">

**Framework-agnostic SDK for building AI agents**

[Features](#features) • [Installation](#installation) • [Quick Start](#quick-start) • [Documentation](#documentation) • [Examples](#examples)

</div>

---

## Overview

Build AI Agent SDK is a framework-agnostic library for building AI agents that
run safely in production: human-in-the-loop approval gates, durable
checkpoint/resume, multi-agent delegation, guardrails, tracing, evals, and a
CLI to scaffold, run locally, and deploy an agent to a Node server, Docker, or
Cloudflare Workers.

**Perfect for:**
- 🤖 Building chatbots and virtual assistants
- 🔄 Creating automated workflows that pause for human approval before a sensitive action
- 🛠️ Integrating LLMs into existing applications
- 🎯 Ops pipelines that watch for errors and open guardrail-gated PRs to fix them

## Features

- 🎯 **Framework Agnostic** - Works with React, Vue, Svelte, Angular, Express, or vanilla JS
- ⚡ **Zero-config to full control** - `createAgent({ prompt, provider })` in one line, or the full `AgentBuilder` + `AgentExecutor` API when you need it
- 🧑‍⚖️ **Human-in-the-loop** - flag a tool `needsApproval` and pause execution until a human approves or rejects it
- 💾 **Durable execution** - checkpoint and resume a run across a crash or restart
- 🤝 **Multi-agent delegation** - wrap a child agent as a tool a parent agent can call, with a `maxDepth` guard against delegation loops
- 🛡️ **Guardrails** - fail-closed, concurrently-run checks (secret scan, diff size, test/lint commands) that gate a fixer agent's patch before it's used
- 📊 **Tracing & evals** - `withSpan()`/`TraceExporter` hooks for observability, and a `defineEval()` API that runs agent-behavior regression tests under `vitest`
- 🔌 **MCP client** - load any Model Context Protocol server's tools as `ToolDescriptor`s
- 📦 **Sandboxing** - opt a tool into running through a `SandboxAdapter` (Docker-backed) instead of in-process
- 🚀 **CLI** - `create-loushy-agent` scaffolds a project, `loushy dev` runs a local chat server with hot reload, `loushy build` deploys to a Node server, Docker, or Cloudflare Workers
- 📝 **Declarative specs** - describe an agent as a YAML/JSON file instead of code
- 🔧 **Extensible** - easy to add custom tools, flows, and providers
- 🧪 **Type-Safe** - full TypeScript support with comprehensive type definitions
- 🔒 **Secure** - random-salt encryption, an SSRF-hardened HTTP tool, a scope-limited GitHub tool

## Installation

```bash
npm install @loushy/build-ai-agent ai zod
# or
pnpm add @loushy/build-ai-agent ai zod
# or
yarn add @loushy/build-ai-agent ai zod
```

### Peer dependencies

`ai` (the Vercel AI SDK, `^4.3.19`) and `zod` (`^3.25.76`) are required. Each
real LLM provider is backed by an optional peer dependency:

| Provider   | Package              | Range     |
| ---------- | --------------------- | --------- |
| OpenAI     | `@ai-sdk/openai`      | `^0.0.42` |
| OpenRouter | `@ai-sdk/openai`      | `^0.0.42` |
| Anthropic  | `@ai-sdk/anthropic`   | `^0.0.42` |
| Ollama     | `ollama-ai-provider`  | `^1.2.0`  |

> **Current limitation:** the package root currently loads every provider
> module on import, so today all three provider packages need to be
> installed even if you only use one (or only the built-in mock provider) —
> see [Installation](docs/installation.md) for the exact command and the
> tracked follow-up.

## Quick Start

> For the verified, copy-paste-runnable version of everything below (each
> snippet is executed against a real packed build by
> `npx tsx scripts/verify-docs-snippets.ts`), see
> [docs/quick-start.md](docs/quick-start.md).

### 1. The zero-config path: `createAgent()`

```typescript
import { createAgent, resolveProvider } from '@loushy/build-ai-agent';

const agent = createAgent({
  prompt: 'You are a helpful customer support assistant.',
  provider: resolveProvider('openai/gpt-4o-mini'), // reads OPENAI_API_KEY
});

const result = await agent.send('Hello!');
console.log(result.text);
```

No manually-constructed repositories, executor, or provider object required
— `createAgent()` defaults everything else and hands back a `{ send }`
agent. Swap `resolveProvider(...)` for `createMockProvider(...)` to run
without any API key at all.

### 2. Full control: `AgentBuilder` + `AgentExecutor`

`createAgent()` is a thin wrapper over these two — use them directly when
you need `maxSteps`, approval gates, checkpoints, tracing hooks, or a
`ToolRegistry` with several tools wired in. `AgentExecutor` is a **static**
API — there is no `new AgentExecutor()`.

```typescript
import { AgentBuilder, AgentExecutor, AgentType, resolveProvider } from '@loushy/build-ai-agent';

const agent = AgentBuilder.create()
  .setType(AgentType.SmartAssistant)
  .setName('Customer Support Agent')
  .setPrompt('You are a helpful customer support assistant.')
  .build();

const result = await AgentExecutor.execute({
  agent,
  input: 'My order arrived damaged.',
  provider: resolveProvider('openai/gpt-4o-mini'),
  maxSteps: 5,
});

console.log(result.text);
console.log(result.usage.totalTokens, result.finishReason, result.steps);
```

### 3. Or describe the agent as data: a spec file

```yaml
# agent.yaml
name: support-bot
prompt: You are a friendly support agent.
provider:
  type: openai
  model: gpt-4o-mini
tools:
  - current-date
  - http
```

```bash
npx loushy dev agent.yaml                                 # chat UI + hot reload
npx loushy build --target=node-server --agent=agent.yaml   # deployable server
```

## Documentation

- [Installation](docs/installation.md) - requirements, peer/provider packages, installing from a local build
- [Quick Start](docs/quick-start.md) - runnable, verified snippets: `createAgent()`, tools, `AgentBuilder` + `AgentExecutor`, spec files
- [Configuration](docs/configuration.md) - agent spec fields, provider env vars, `AgentExecutor.execute()` options, CLI flags
- [Deployment](docs/deployment.md) - `loushy build` targets: Node server, Docker, Cloudflare Workers
- [API Overview](docs/api-overview.md) - the main exports; `npm run docs:build` generates the full TypeDoc reference
- Full guides site: [linuxdevil.github.io/agent-sdk-docs](https://linuxdevil.github.io/agent-sdk-docs/)

## Core Concepts

### Agents

Agents combine a **type** (`AgentType.SmartAssistant`, etc.), a **prompt**,
**tools**, optional **flows**, and conversation **memory**. Build one with
`createAgent()` for the common case, or `AgentBuilder` when you need full
control over the resulting `AgentConfig`.

### Tools

```typescript
import { ToolRegistry } from '@loushy/build-ai-agent';
import { tool } from 'ai';
import { z } from 'zod';

const registry = new ToolRegistry();

registry.register('weather', {
  displayName: 'Get weather',
  tool: tool({
    description: 'Get weather information',
    parameters: z.object({
      location: z.string(),
      units: z.enum(['celsius', 'fahrenheit']),
    }),
    execute: async ({ location, units }) => {
      // Your implementation
      return { temperature: 72, conditions: 'sunny' };
    },
  }),
});
```

A `ToolDescriptor` can also opt into two safety primitives:

```typescript
registry.register('send_email', {
  displayName: 'Send email',
  tool: emailTool,
  needsApproval: (args) => args.to.includes('@external.com'), // pauses for a human
  requiresSandbox: true, // routes through the configured SandboxAdapter
  sandboxExecute: async (args, sandbox) => sandbox.run('node', ['send-email.js', JSON.stringify(args)]),
});
```

### Flows

Flows orchestrate multi-step workflows within a single agent:

```typescript
import { FlowBuilder, FlowExecutor } from '@loushy/build-ai-agent';

const flow = new FlowBuilder()
  .addNode({ id: 'start', type: 'llm', data: { prompt: 'Analyze user input' } })
  .addNode({ id: 'decide', type: 'conditional', data: { condition: 'output.sentiment === "positive"' } })
  .addEdge('start', 'decide')
  .build();

// FlowExecutor is a static API too: execute(flow, context, onEvent?)
const result = await FlowExecutor.execute(flow, { agent, provider, variables: {} });
```

### LLM Providers

```typescript
import { resolveProvider, LLMProviderRegistry } from '@loushy/build-ai-agent';

// The convenient way — reads the credential from the environment
const openai = resolveProvider('openai/gpt-4o-mini');       // OPENAI_API_KEY
const anthropic = resolveProvider('anthropic/claude-sonnet-5'); // ANTHROPIC_API_KEY
const openrouter = resolveProvider('openrouter/openai/gpt-4o-mini'); // OPENROUTER_API_KEY
const ollama = resolveProvider('ollama/llama3.1');           // OLLAMA_BASE_URL

// Or construct a provider directly via the registry
const custom = LLMProviderRegistry.create('openai', {
  apiKey: process.env.OPENAI_API_KEY,
  defaultModel: 'gpt-4o-mini',
});
```

## Advanced Features

### Human-in-the-loop approval gates

Flag a tool `needsApproval`; `AgentExecutor` pauses before calling it and
persists an `ExecutionSnapshot` instead of invoking the tool. Resume later —
after a real restart if you like — with `resumeAfterApproval()`:

```typescript
import { AgentExecutor, resumeAfterApproval, StorageServiceApprovalStore } from '@loushy/build-ai-agent';

const approvalStore = new StorageServiceApprovalStore(storage);

const paused = await AgentExecutor.execute({
  agent, input, provider, toolRegistry, approvalStore,
});
// paused.finishReason === 'awaiting-approval', paused.approvalId is set

// ...later, from any process, after a human approves...
const result = await resumeAfterApproval(
  { id: paused.approvalId!, approved: true },
  approvalStore,
  provider,
  toolRegistry,
);
```

### Durable execution / checkpoints

Pass a `sessionId` and a `checkpointStore`; `AgentExecutor` saves a
checkpoint after every tool result and rehydrates from it on the next call
with the same `sessionId` — so a crash mid-conversation resumes rather than
restarts:

```typescript
import { AgentExecutor, LocalStorageCheckpointStore } from '@loushy/build-ai-agent';

const checkpointStore = new LocalStorageCheckpointStore(storage);

await AgentExecutor.execute({ agent, input, provider, sessionId: 'session-123', checkpointStore });
// ...process restarts...
await AgentExecutor.execute({ agent, input: 'continue', provider, sessionId: 'session-123', checkpointStore });
```

### Multi-agent delegation

Wrap a child `AgentConfig` as a tool so a parent agent can delegate a task to
it, running the child through `AgentExecutor.execute()` under the hood:

```typescript
import { AgentExecutor, createDelegateTool, ToolRegistry, AgentType } from '@loushy/build-ai-agent';

const billingAgent = {
  name: 'Billing Agent',
  agentType: AgentType.SmartAssistant,
  prompt: 'You answer billing questions and look up invoices.',
};

const registry = new ToolRegistry();
registry.register(
  'delegate_billing_agent',
  createDelegateTool({
    agent: billingAgent,
    provider,
    contextMode: 'none', // 'full-history' shares the parent's context array too
    maxSteps: 10,
    maxDepth: 3, // bounds a delegation chain (e.g. A -> B -> A) before it throws
  })
);

const supportAgent = {
  name: 'Support Agent',
  agentType: AgentType.SmartAssistant,
  prompt: 'You help customers. Delegate billing questions to the billing agent.',
  tools: { delegate_billing_agent: { tool: 'delegate_billing_agent' } },
};

const result = await AgentExecutor.execute({
  agent: supportAgent,
  input: 'Why was I charged twice this month?',
  provider,
  toolRegistry: registry,
});
```

### Guardrails

Fail-closed, concurrently-run checks over a proposed patch/action — used to
gate a fixer agent before it's trusted to open a PR:

```typescript
import { runGuardrails, secretScanGuardrail, createDiffSizeGuardrail, createCommandGuardrail } from '@loushy/build-ai-agent';

const verdict = await runGuardrails(
  { diff: patch },
  [
    secretScanGuardrail,
    createDiffSizeGuardrail(500),
    createCommandGuardrail('test-run', repoPath, 'npm', ['test']),
  ],
);

if (!verdict.pass) {
  console.log(verdict.failures); // [{ name, reason }, ...] — never call the write-side tool
}
```

### Tracing & observability

```typescript
import { AgentExecutor, withSpan } from '@loushy/build-ai-agent';

const exporter = {
  onSpanStart: (span) => console.log('[start]', span.name, span.attributes),
  onSpanEnd: (span) => console.log('[end]', span.name, span.endTime! - span.startTime, 'ms'),
};

await AgentExecutor.execute({
  agent, input, provider, exporter,
  redactContent: true, // omit prompt/tool-arg/result bodies from span attributes
});
```

Ready-made exporters live in [examples/tracing](examples/tracing) (console
and real OpenTelemetry bridges).

### Evals

Agent-behavior regression tests, run via `vitest run` alongside your normal
test suite — no new test runner:

```typescript
// support-agent.eval.ts
import { defineEval, exactMatch, toolCallOrder } from '@loushy/build-ai-agent';

defineEval({
  name: 'looks up the order before replying',
  agent, provider, toolRegistry,
  input: 'Where is order #123?',
  score: toolCallOrder([{ tool: 'lookupOrder' }]),
  threshold: 1,
});
```

### MCP tools & sandboxing

```typescript
import { loadMcpTools } from '@loushy/build-ai-agent/tools/mcp/McpToolLoader';
import { SubprocessSandbox } from '@loushy/build-ai-agent';

// Turn any MCP server's tools into ToolDescriptors, namespaced <connection>__<tool>
const linearTools = await loadMcpTools(mcpClient, 'linear');
registry.registerMany(linearTools);

// Route a flagged tool (requiresSandbox + sandboxExecute) through a real,
// Docker-backed sandbox instead of the in-process NoopSandbox default
await AgentExecutor.execute({ agent, input, provider, toolRegistry, sandbox: new SubprocessSandbox() });
```

### Security & encryption

```typescript
import { EncryptionUtils, sha256 } from '@loushy/build-ai-agent';

const encryption = new EncryptionUtils('your-secret-key');
const encrypted = await encryption.encrypt('sensitive data'); // fresh random salt every call
const decrypted = await encryption.decrypt(encrypted);        // throws DecryptionError on tampering

const hash = await sha256('password', 'salt');
```

### Storage

```typescript
import { StorageService } from '@loushy/build-ai-agent';
import fs from 'node:fs';
import path from 'node:path';

// fs/path are injected as typed adapters (LOU-A7) rather than `any`
const storage = new StorageService('user-123', 'attachments', fs, path);

await storage.saveAttachment(file, 'document.pdf');
const buffer = storage.readAttachment('document.pdf');
storage.deleteAttachment('document.pdf');
```

### Templates

```typescript
import { renderTemplate } from '@loushy/build-ai-agent';

const template = 'Hello {{ name }}! You have {{ count }} messages.';
const result = renderTemplate(template, { name: 'Alice', count: 5 });
// "Hello Alice! You have 5 messages."
```

## CLI

```bash
npx create-loushy-agent --name=my-agent --provider=openai --yes  # scaffold a project
npx loushy dev agent.yaml                                        # local chat UI + hot reload
npx loushy build --target=node-server --agent=agent.yaml         # or docker / cloudflare-worker
```

See [Installation](docs/installation.md) and [Deployment](docs/deployment.md)
for the full flag reference.

## Examples

Runnable example agents (support bot, research assistant, workflow router,
doc Q&A, Slack notifier, tracing) live in [examples/](examples/README.md).
The flagship one is [examples/ops-pipeline](examples/ops-pipeline) — an
end-to-end Grafana/Datadog → Slack "Fix it" button → human approval → fixer
agent → guardrail-gated GitHub PR pipeline, runnable against mocks with zero
external network access:

```bash
npm run pipeline:demo
npm run pipeline:demo:trigger   # POSTs a synthetic error to kick it off
```

## API Reference

### Core

- **`createAgent()`** - zero-config `{ send }` agent
- **`AgentBuilder`** - fluent `AgentConfig` builder
- **`AgentExecutor`** - static executor (`execute()`, approvals, checkpoints, tracing)
- **`ToolRegistry`** - manage available tools
- **`FlowBuilder`** / **`FlowExecutor`** - multi-step workflow graphs
- **`MemoryManager`** - conversation context

### Safety & ops

- **`resumeAfterApproval()`**, **`StorageServiceApprovalStore`** - human-in-the-loop
- **`LocalStorageCheckpointStore`** - durable execution
- **`createDelegateTool()`** - multi-agent delegation
- **`runGuardrails()`**, **`secretScanGuardrail`**, **`createDiffSizeGuardrail()`**, **`createCommandGuardrail()`** - guardrails
- **`withSpan()`**, **`TraceExporter`** - tracing
- **`defineEval()`**, **`exactMatch`**, **`toolCallOrder`**, **`budget`**, **`llmJudge()`** - evals
- **`NoopSandbox`**, **`SubprocessSandbox`** - sandboxing

### Providers

- **`resolveProvider()`** - `"provider/model"` string → configured provider
- **`OpenAIProvider`**, **`AnthropicProvider`**, **`OllamaProvider`**, **`OpenRouterProvider`**
- **`createMockProvider()`** - deterministic provider for tests and demos

### Deploy & specs

- **`loadSpec()`**, **`agentSpecSchema`**, **`specToAgent()`** - declarative agent files
- **`registerAdapter()`**, **`getAdapter()`**, **`listAdapters()`** - `loushy build` targets

### Utilities

- **`EncryptionUtils`**, **`sha256`** - encryption/hashing
- **`StorageService`** - file storage
- **`renderTemplate`** - template rendering

For the complete, generated reference (every export, signature, and doc
comment), see [docs/api-overview.md](docs/api-overview.md) or run
`npm run docs:build`.

## Architecture

```
┌─────────────────────────────────────┐
│         Your Application            │
│    (React, Vue, Express, etc.)      │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│     @loushy/build-ai-agent          │
│  ┌────────────────────────────┐    │
│  │ createAgent / Builder /     │    │
│  │ Executor (approvals,        │    │
│  │ checkpoints, tracing)       │    │
│  ├────────────────────────────┤    │
│  │ Tools │ Delegation │ MCP    │    │
│  │ Flows │ Guardrails │ Evals  │    │
│  ├────────────────────────────┤    │
│  │       Core Engine          │    │
│  └────────────────────────────┘    │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│  Your LLM Provider & Deploy Target  │
│ (OpenAI/Anthropic/Ollama/OpenRouter,│
│  Node server / Docker / Workers)    │
└─────────────────────────────────────┘
```

## Testing

```bash
npm test                # run tests
npm run test:coverage   # with coverage thresholds enforced
npm run typecheck       # tsc --noEmit
npm run lint             # eslint
```

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Roadmap

Known, intentionally-deferred follow-ups (see the audit's
[implementation status](https://claude.ai/artifact/HK4vf7D7EifeHowNB3f6Ub#status)
for full context on each):

- [ ] Make the root entry point's provider imports genuinely optional (currently all three peer SDKs must be installed even if only one provider is used)
- [ ] Real provider support (OpenAI/Anthropic/Ollama/OpenRouter) for the Cloudflare Workers deploy target (currently mock-provider only)
- [ ] Process-group kill for timed-out guardrail commands on POSIX (verified working on Windows; POSIX path untested against multi-process command trees)
- [ ] Interactive, in-browser runnable Quick Start snippets (current verification is real but non-interactive - see `scripts/verify-docs-snippets.ts`)
- [ ] Additional database adapters (Prisma, MongoDB) alongside the existing Drizzle support

## Support

- 📖 [Documentation site](https://linuxdevil.github.io/agent-sdk-docs/)
- 📘 [In-repo docs](docs/) and [examples](examples/)

## License

MIT © [Build AI Agent](LICENSE)
