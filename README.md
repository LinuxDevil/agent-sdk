# @loushy/build-ai-agent

![CI](https://github.com/LinuxDevil/agent-sdk/actions/workflows/ci.yml/badge.svg)
[![npm](https://img.shields.io/npm/v/@loushy/build-ai-agent)](https://www.npmjs.com/package/@loushy/build-ai-agent)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A composable, framework-agnostic SDK for building AI agents that run safely
in production.** Zero-config to full control, human-in-the-loop approval
gates, durable checkpoints, multi-agent delegation, guardrails, and a visual
dashboard — any provider, any deploy target, no lock-in.

[Get started](docs/quick-start.md) &nbsp;·&nbsp;
[View on GitHub](https://github.com/LinuxDevil/agent-sdk) &nbsp;·&nbsp;
[Docs site](https://linuxdevil.github.io/agent-sdk-docs/) &nbsp;·&nbsp;
[npm](https://www.npmjs.com/package/@loushy/build-ai-agent)

---

## Features

- **Zero-config to full control** — `createAgent({ model: 'openai/gpt-4o-mini' })` in one line, or the full `AgentBuilder` + `AgentExecutor` API when you need `maxSteps`, checkpoints, or tracing hooks
- **Human-in-the-loop** — flag a tool `needsApproval` and pause execution until a human approves or rejects it, then `resumeAfterApproval()` from any process
- **Durable execution** — pass a `sessionId` + `checkpointStore` and a crash mid-conversation resumes instead of restarting
- **Cancellation** — pass an `AbortSignal` (`agent.send(input, { signal })`) to stop a run; it resolves with `finishReason: 'aborted'` and the transcript so far, and the signal reaches the provider, tools and delegated agents
- **Sessions** — `agent.session()` keeps a multi-turn conversation (in memory, or persisted with `FileSessionStore`)
- **Project instructions** — `createAgent({ projectInstructions: true })` appends the nearest `AGENTS.md` / `CLAUDE.md` to the instructions (opt-in)
- **Parallel tool calls** — when the model asks for several tools in one turn they run concurrently (cap it with `toolConcurrency`, or `1` for sequential), and results still reach the transcript in the model's call order
- **Skills** — `defineSkill()` / `loadSkills('./skills')`: only each skill's name and description sit in the system prompt; the model loads the full markdown on demand through an auto-registered `load_skill` tool
- **Multi-agent delegation** — wrap a child agent as a tool with `createDelegateTool()`, with a `maxDepth` guard against delegation loops
- **Pre/post hooks** — a `HookRegistry` of `AgentHook`s that can inspect or mutate a tool call/LLM generate step, or throw to abort it, run sandboxed by Agent Forge's hook editor
- **Guardrails** — fail-closed, concurrently-run checks (secret scan, diff size, test/lint commands) that gate a fixer agent's patch before it's used
- **Workspace tools** — `createFsTools()` (`read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`) and `createShellTool()` over pluggable `FsProvider`/`ShellProvider` backends (`NodeWorkspace`, `MemoryWorkspace`, Docker-backed `SandboxShell`), with paths confined to the workspace root (symlinks included) and shell commands approval-gated by default — see [Workspace tools](docs/workspace-tools.md)
- **MCP client** — `loadMcpTools()` turns any Model Context Protocol server's tools into `ToolDescriptor`s
- **MCP server** — `serveMcp({ agent, name })` (or `loushy mcp agent.yaml`) exposes an agent as an MCP tool for Claude Code, Cursor and other agents
- **Sandboxed tools** — opt a tool into `requiresSandbox` to route it through a Docker-backed `SandboxAdapter` instead of in-process
- **Tracing & evals** — `withSpan()`/`TraceExporter` (with an OpenTelemetry bridge at `/otel`) for observability, and `defineEval()` for agent-behavior regression tests under `vitest`
- **Any provider, any deploy target** — OpenAI, Anthropic, Ollama, OpenRouter, or a deterministic mock provider for tests; `loushy build` ships to a Node server, Docker, or Cloudflare Workers
- **Agent Forge** — `loushy studio` launches a visual dashboard: drag-and-drop graph canvas, live run/debug console with a step-through debugger, real chat with inline approval-gate cards, and a sandboxed hook editor

## Quick example

Hello world in five lines (reads `OPENAI_API_KEY` from your environment):

```typescript
import { createAgent } from '@loushy/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini', instructions: 'You are a helpful assistant.' });
const { text } = await agent.send('Hello!');
console.log(text);
```

`model` is a `provider/model` string (`openai`, `anthropic`, `openrouter`,
`ollama`); the key comes from the provider's conventional env var. Leave
`model` out and the agent uses `LOUSHY_MODEL` if set, otherwise the first of
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
`OLLAMA_BASE_URL` that is present.

When you need a custom provider (your own `LLMProvider`, a mock, extra
config), pass the instance instead:

```typescript
import { createAgent, createMockProvider } from '@loushy/build-ai-agent';

const agent = createAgent({
  instructions: 'You are a helpful customer support assistant.',
  provider: createMockProvider({ responses: ['Hi! How can I help?'] }),
});
```

The same agent with an approval gate on a sensitive tool — `defineTool()`
infers the argument types from the zod `input`, and `AgentExecutor` pauses
before calling the tool and persists a resumable snapshot instead:

```typescript
import { AgentExecutor, resumeAfterApproval, StorageServiceApprovalStore, ToolRegistry, defineTool } from '@loushy/build-ai-agent';
import { z } from 'zod';

const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send an email',
  input: z.object({ to: z.string().email(), subject: z.string(), body: z.string() }),
  needsApproval: ({ to }) => !to.endsWith('@mycompany.com'), // `to` is typed; pauses for a human
  async execute({ to, subject, body }) {
    return { messageId: '...' };
  },
});

const registry = new ToolRegistry();
registry.register(sendEmail);

const approvalStore = new StorageServiceApprovalStore(storage);
const paused = await AgentExecutor.execute({
  agent, input, provider, toolRegistry: registry, approvalStore,
});
// paused.finishReason === 'awaiting-approval', paused.approvalId is set

// ...later, from any process, after a human approves...
const result = await resumeAfterApproval(
  { id: paused.approvalId!, approved: true },
  approvalStore,
  registry,
  provider,
);
```

## Quickstart

**1. Install**

```bash
npm install @loushy/build-ai-agent ai zod
npx loushy doctor        # checks Node, peers and API keys, and tells you how to fix anything
```

**2. Configure** — describe the agent as data:

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

**3. Run**

```bash
npx loushy dev agent.yaml                                 # chat UI + hot reload
npx loushy build --target=node-server --agent=agent.yaml   # deployable server
```

## Overview

Build AI Agent SDK is a framework-agnostic library for building AI agents that
run safely in production: human-in-the-loop approval gates, durable
checkpoint/resume, multi-agent delegation, guardrails, tracing, evals, and a
CLI to scaffold, run locally, and deploy an agent to a Node server, Docker, or
Cloudflare Workers. Works with React, Vue, Svelte, Angular, Express, or
vanilla JS — nothing about the SDK is tied to a particular framework.

**Perfect for:**
- 🤖 Building chatbots and virtual assistants
- 🔄 Creating automated workflows that pause for human approval before a sensitive action
- 🛠️ Integrating LLMs into existing applications
- 🎯 Ops pipelines that watch for errors and open guardrail-gated PRs to fix them

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

## Full control: `AgentBuilder` + `AgentExecutor`

> For the verified, copy-paste-runnable version of every snippet in this
> README (each is executed against a real packed build by
> `npx tsx scripts/verify-docs-snippets.ts`), see
> [docs/quick-start.md](docs/quick-start.md).

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

### Multi-turn sessions

```ts
import { createAgent } from '@loushy/build-ai-agent';

const session = createAgent({ provider }).session(); // or .session({ id, store: new FileSessionStore(dir) })
await session.send('My name is Ali.');
const { text } = await session.send('What is my name?'); // remembers
console.log(session.id, session.messages.length);
```

## Documentation

- [Installation](docs/installation.md) - requirements, peer/provider packages, installing from a local build
- [Quick Start](docs/quick-start.md) - runnable, verified snippets: `createAgent()`, tools, `AgentBuilder` + `AgentExecutor`, spec files
- [Configuration](docs/configuration.md) - agent spec fields, provider env vars, `AgentExecutor.execute()` options, CLI flags
- [Deployment](docs/deployment.md) - `loushy build` targets: Node server, Docker, Cloudflare Workers
- [API Overview](docs/api-overview.md) - the main exports; `npm run docs:build` generates the full TypeDoc reference
- [Workspace tools](docs/workspace-tools.md) - file system and shell tools for coding agents, and their security model
- [Tracing and observability](docs/observability.md) - OpenTelemetry GenAI spans, attribute table, content opt-in
- [Testing](docs/testing.md) - unit-test agents deterministically with the scripted `mockModel`
- [Evals](docs/evals.md) - trajectory evals with `defineEval()`, datasets, `mockModel`, judge evals, `loushy eval` with JUnit/JSON reports
- [Sessions](docs/sessions.md) - multi-turn conversations: `agent.session()`, `MemorySessionStore`, `FileSessionStore`
- [Skills](docs/skills.md) - on-demand instructions: `defineSkill()`, `loadSkills()`, how they save context
- [Agent Forge](docs/agent-forge.md) - the visual dashboard (`loushy studio`): quickstart, first-agent walkthrough, hook authoring
- Full guides site: [linuxdevil.github.io/agent-sdk-docs](https://linuxdevil.github.io/agent-sdk-docs/)

## For AI coding agents

This package ships its documentation in machine-readable form, so a coding
agent can read it straight from `node_modules` without browsing the web:

- `node_modules/@loushy/build-ai-agent/llms-full.txt` - the README and every
  user-facing docs page in one file, with absolute links.
- `llms.txt` (repo root, also in the package) - a short [llmstxt.org](https://llmstxt.org)
  index of the docs and examples.
- `llms-full.txt` (repo root) - the same full text as above, for use from a clone.

Both files are generated (`npm run docs:llms`) and checked in CI.

## Core Concepts

### Agents

Agents combine a **type** (`AgentType.SmartAssistant`, etc.), a **prompt**,
**tools**, optional **flows**, and conversation **memory**. Build one with
`createAgent()` for the common case, or `AgentBuilder` when you need full
control over the resulting `AgentConfig`.

### Tools

Define a tool with `defineTool()` — argument and result types are inferred from
the zod `input`, and the result drops in anywhere tools are accepted
(`createAgent({ tools: [...] })`, `ToolRegistry.register(tool)`,
`AgentBuilder.addTool(tool)`):

```typescript
import { defineTool, createAgent, type ToolInput, type ToolOutput } from '@loushy/build-ai-agent';
import { z } from 'zod';

const weather = defineTool({
  name: 'weather', // 1-64 chars: letters, digits, _ and -
  description: 'Get weather information',
  input: z.object({ location: z.string(), units: z.enum(['celsius', 'fahrenheit']) }),
  execute: async ({ location, units }) => ({ temperature: 72, conditions: 'sunny' }),
});

type WeatherArgs = ToolInput<typeof weather>;   // { location: string; units: 'celsius' | 'fahrenheit' }
type WeatherResult = ToolOutput<typeof weather>; // { temperature: number; conditions: string }

const agent = createAgent({ prompt: '...', provider, tools: [weather] });
```

Optional fields mirror `ToolDescriptor`: `displayName`, `needsApproval` (boolean
or a predicate typed from `input`), `requiresSandbox` and `sandboxExecute`
(routes through the configured `SandboxAdapter`).

**Advanced: `ToolRegistry`.** For raw `ToolDescriptor`s (built-in tools, MCP
tools, an existing `tool()` from the `ai` SDK) register by name:
`registry.register('weather', { displayName: 'Get weather', tool: aiSdkTool })`.

### Flows

Flows orchestrate multi-step workflows within a single agent:

```typescript
import { FlowBuilder, FlowExecutor, type EditorStep } from '@loushy/build-ai-agent';

// FlowBuilder is a metadata builder: setCode/setName/setInputs/setFlow(...).build().
// EditorStep covers every node type FlowExecutor runs ('sequence', 'llmCall',
// 'oneOf', 'setVariable', ...).
const steps: EditorStep = {
  type: 'sequence',
  steps: [
    { type: 'llmCall', prompt: 'Classify this message as billing, technical or sales: {{message}}', outputVariable: 'category' },
    { type: 'llmCall', prompt: 'Write a one-line reply for a {{category}} request: {{message}}' },
  ],
};

const flow = new FlowBuilder()
  .setCode('triage')
  .setName('Triage')
  .addInput({ name: 'message', type: 'shortText', required: true })
  .setFlow(steps)
  .build();

// FlowExecutor is a static API too: execute(flow, context, onEvent?)
const result = await FlowExecutor.execute(flow, { agent, provider, variables: { message: input } });
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

**Which model runs?** In order: the agent's own `settings.model` (set with
`AgentBuilder.setSettings({ model })`), then the model the provider was built
with (`resolveProvider('openai/gpt-4o-mini')`, a spec's `provider.model`, or
`defaultModel`), then the provider's built-in default. There is no hard-coded
fallback model.

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
  toolRegistry,
  provider,
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
import { AgentExecutor, withSpan, type TraceExporter } from '@loushy/build-ai-agent';

const exporter: TraceExporter = {
  onSpanStart: (span) => console.log('[start]', span.name, span.attributes),
  onSpanEnd: (span) => console.log('[end]', span.name, span.endTime! - span.startTime, 'ms'),
};

await AgentExecutor.execute({
  agent, input, provider, exporter,
  redactContent: true, // omit prompt/tool-arg/result bodies from span attributes
});
```

Spans follow the OpenTelemetry GenAI semantic conventions (`invoke_agent`,
`chat {model}`, `execute_tool {tool}`; flows are traced too). Message and
tool-argument content is only recorded with `captureContent: true`. See
[Tracing and observability](docs/observability.md) for the attribute table,
the opt-in and the deprecated pre-GenAI names.

Ready-made exporters live in [examples/tracing](examples/tracing) (console
and real OpenTelemetry bridges).

### Evals

Agent-behavior regression tests: assert on the tools an agent called, their
order and arguments, its steps and its reply. Deterministic with `mockModel`,
datasets via `cases`, soft vs gate assertions, and `loushy eval` for a summary
table plus JUnit/JSON reports in CI:

```typescript
// support-agent.eval.ts
import { z } from 'zod';
import { createAgent, defineEval, defineTool, includes } from '@loushy/build-ai-agent';
import { mockModel } from '@loushy/build-ai-agent/testing';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order',
  input: z.object({ orderId: z.string() }),
  execute: ({ orderId }) => ({ orderId, status: 'shipped' }),
});

defineEval({
  name: 'looks up the order before replying',
  agent: () =>
    createAgent({
      tools: [lookupOrder],
      provider: mockModel([
        { toolCalls: [{ name: 'lookup_order', args: { orderId: '123' } }] },
        { text: 'Order 123 has shipped.' },
      ]),
    }),
  async test(t) {
    await t.send('Where is order #123?');
    t.completed();
    t.calledTool('lookup_order', { args: { orderId: '123' } });
    t.check('says shipped', t.reply, includes('shipped'));
  },
});
```

```bash
npx loushy eval --junit reports/evals.xml
```

See [Evals](docs/evals.md) for the assertions table, datasets, judge evals and
a CI example. The original `{ agent, input, provider, score, threshold }` form
of `defineEval()` keeps working.

### MCP tools & sandboxing

```typescript
import { loadMcpTools } from '@loushy/build-ai-agent/mcp';
import { AgentExecutor, SubprocessSandbox } from '@loushy/build-ai-agent';

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
import * as fs from 'node:fs';
import * as path from 'node:path';

// fs/path are injected as adapters (LOU-A7); the Node modules satisfy them as-is.
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

## Agent Forge

Agent Forge is this SDK's companion visual dashboard: a ReactFlow canvas for
building an agent's graph (trigger → LLM → tool → output), a run/debug
console (live logs, a span trace waterfall, a step-through debugger), real
chat with inline approval-gate cards, and a sandboxed pre/post hook editor -
all reading and writing the same `AgentSpec` YAML `loushy dev`/`loushy build`
use.

```bash
npx loushy studio                 # build an agent, run it (mock provider by
                                   # default), watch it in the debug console
```

`loushy studio` serves the whole app - API and UI - from one local server and
port; no separate dev server or extra setup needed. See
[docs/agent-forge.md](docs/agent-forge.md) for the full quickstart, a
first-agent walkthrough, and how to write and attach a hook.

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
