# @loushy/build-ai-agent

![CI](https://github.com/LinuxDevil/agent-sdk/actions/workflows/ci.yml/badge.svg)

<div align="center">

**Framework-agnostic SDK for building AI agents**

[Features](#features) • [Installation](#installation) • [Quick Start](#quick-start) • [Documentation](#documentation) • [Examples](#examples)

</div>

---

## Overview

Build AI Agent SDK is a powerful, framework-agnostic library for building intelligent AI agents. It provides a clean, type-safe API for creating agents with tools, flows, and custom capabilities.

**Perfect for:**
- 🤖 Building chatbots and virtual assistants
- 🔄 Creating automated workflows
- 🛠️ Integrating LLMs into existing applications
- 🎯 Developing custom AI-powered tools

## Features

- 🎯 **Framework Agnostic** - Works with React, Vue, Svelte, Angular, Express, or vanilla JS
- 🔧 **Extensible** - Easy to add custom tools, flows, and providers
- 🧪 **Type-Safe** - Full TypeScript support with comprehensive type definitions
- 📦 **Modular** - Use only what you need with tree-shakeable exports
- 🚀 **Production Ready** - Built-in error handling, retries, and circuit breakers
- 🔒 **Secure** - Built-in encryption, hashing, and security utilities
- 💾 **Storage** - File storage with concurrency locking
- 🎨 **Templates** - Jinja2-like template rendering for prompts
- 🔄 **Streaming** - Real-time streaming responses
- 🧠 **Memory** - Conversation context and memory management
- ⚡ **Fast** - Optimized bundle size (~120KB)

## Installation

```bash
npm install @loushy/build-ai-agent ai zod
# or
pnpm add @loushy/build-ai-agent ai zod
# or
yarn add @loushy/build-ai-agent ai zod
```

### Peer Dependencies

The SDK requires:
- `ai` ^4.1.54 - Vercel AI SDK
- `zod` ^3.23.8 - Schema validation
- `@ai-sdk/openai` ^0.0.42 (for OpenAI provider)
- `ollama-ai-provider` ^1.2.0 (for Ollama provider)

## Quick Start

> For a verified, copy-paste-runnable walkthrough of the current API
> (`createAgent()`, the static `AgentExecutor.execute()`, spec files), see
> [docs/quick-start.md](docs/quick-start.md).

### 1. Build an Agent

```typescript
import { AgentBuilder, AgentType } from '@loushy/build-ai-agent';

const agent = new AgentBuilder()
  .setType(AgentType.SmartAssistant)
  .setName('Customer Support Agent')
  .setPrompt('You are a helpful customer support assistant.')
  .addTool('http', {
    tool: 'httpRequest',
    options: { method: 'GET' }
  })
  .build();
```

### 2. Configure Repositories

```typescript
import { createMockRepositories } from '@loushy/build-ai-agent';

// For development/testing
const repositories = createMockRepositories();

// For production with Drizzle ORM
import { createDrizzleRepositories } from '@loushy/build-ai-agent-drizzle';
const repositories = createDrizzleRepositories(db);
```

### 3. Execute the Agent

```typescript
import { AgentExecutor } from '@loushy/build-ai-agent';

const executor = new AgentExecutor({
  agent,
  sessionId: 'session-123',
  repositories,
  llmProvider: myLLMProvider
});

// Simple execution
const result = await executor.execute({
  messages: [{ role: 'user', content: 'Hello!' }]
});

console.log(result.response); // Agent's response

// Streaming execution
const stream = await executor.executeStream({
  messages: [{ role: 'user', content: 'Tell me a story' }]
});

for await (const chunk of stream) {
  process.stdout.write(chunk.content);
}
```

## Documentation

- [Installation](docs/installation.md) - requirements, peer/provider packages, installing from a local build
- [Quick Start](docs/quick-start.md) - runnable, verified snippets: `createAgent()`, tools, `AgentBuilder` + `AgentExecutor`, spec files
- [Configuration](docs/configuration.md) - agent spec files, provider credentials, execution options, CLI flags
- [Deployment](docs/deployment.md) - `loushy build` targets: Node server, Docker, Cloudflare Workers
- [API Overview](docs/api-overview.md) - the main exports; `npm run docs:build` generates the full TypeDoc reference

## Core Concepts

### Agents

Agents are the core abstraction. They combine:
- **Type**: Determines behavior (SmartAssistant, Workflow, DataAnalyst, etc.)
- **Prompt**: System instructions
- **Tools**: Available capabilities
- **Flows**: Structured workflows
- **Memory**: Conversation history

### Tools

Tools extend agent capabilities:

```typescript
import { ToolRegistry } from '@loushy/build-ai-agent';

const registry = new ToolRegistry();

// Register a custom tool
registry.register({
  name: 'weather',
  description: 'Get weather information',
  parameters: z.object({
    location: z.string(),
    units: z.enum(['celsius', 'fahrenheit'])
  }),
  execute: async ({ location, units }) => {
    // Your implementation
    return { temperature: 72, conditions: 'sunny' };
  }
});
```

### Flows

Flows orchestrate multi-step workflows:

```typescript
import { FlowBuilder, FlowNodeType } from '@loushy/build-ai-agent';

const flow = new FlowBuilder()
  .addNode({
    id: 'start',
    type: FlowNodeType.LLM,
    data: { prompt: 'Analyze user input' }
  })
  .addNode({
    id: 'decide',
    type: FlowNodeType.Conditional,
    data: { condition: 'output.sentiment === "positive"' }
  })
  .addEdge('start', 'decide')
  .build();
```

### LLM Providers

Support for multiple LLM providers:

```typescript
import { LLMProviderRegistry } from '@loushy/build-ai-agent';

// OpenRouter - Access 100+ models from multiple providers
const openrouter = LLMProviderRegistry.create('openrouter', {
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultModel: 'openai/gpt-4o-mini'
});

// OpenAI - Direct OpenAI integration
const openai = LLMProviderRegistry.create('openai', {
  apiKey: process.env.OPENAI_API_KEY,
  defaultModel: 'gpt-4'
});

// Ollama - Local LLM support
const ollama = LLMProviderRegistry.create('ollama', {
  baseURL: 'http://localhost:11434',
  defaultModel: 'llama3.1'
});
```

## Advanced Features

### Multi-agent Delegation

Wrap a child `AgentConfig` as a tool so a parent agent can delegate a task
to it, running the child through `AgentExecutor.execute()` under the hood:

```typescript
import {
  AgentExecutor,
  createDelegateTool,
  ToolRegistry,
  AgentType,
} from '@loushy/build-ai-agent';

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
    provider, // an LLMProvider instance
    // contextMode: 'full-history' shares the `context` array the tool is
    // called with (in addition to the delegated task); 'none' (default)
    // gives the child agent only the task as a fresh message.
    contextMode: 'none',
    maxSteps: 10,
    // maxDepth (default 3) bounds how many hops a delegation chain may
    // take (e.g. agent A delegates to B, which delegates back to A, ...)
    // before a DelegationDepthExceededError is thrown.
    maxDepth: 3,
  })
);

const supportAgent = {
  name: 'Support Agent',
  agentType: AgentType.SmartAssistant,
  prompt: 'You help customers. Delegate billing questions to the billing agent.',
  tools: {
    delegate_billing_agent: { tool: 'delegate_billing_agent' },
  },
};

const result = await AgentExecutor.execute({
  agent: supportAgent,
  input: 'Why was I charged twice this month?',
  provider,
  toolRegistry: registry,
});
```

### Security & Encryption

```typescript
import { EncryptionUtils, sha256 } from '@loushy/build-ai-agent';

const encryption = new EncryptionUtils('your-secret-key');
const encrypted = await encryption.encrypt('sensitive data');
const decrypted = await encryption.decrypt(encrypted);

const hash = await sha256('password', 'salt');
```

### Storage

```typescript
import { StorageService } from '@loushy/build-ai-agent';

const storage = new StorageService('user-123', 'attachments');

await storage.saveFile('document.pdf', buffer);
const file = await storage.readFile('document.pdf');
await storage.deleteFile('document.pdf');
```

### Templates

```typescript
import { renderTemplate } from '@loushy/build-ai-agent';

const template = 'Hello {{ name }}! You have {{ count }} messages.';
const result = renderTemplate(template, { name: 'Alice', count: 5 });
// "Hello Alice! You have 5 messages."
```

### Memory Management

```typescript
import { MemoryManager } from '@loushy/build-ai-agent';

const memory = new MemoryManager({
  maxMessages: 10,
  summarizeAfter: 20
});

memory.addMessage({ role: 'user', content: 'Hello' });
memory.addMessage({ role: 'assistant', content: 'Hi there!' });

const context = memory.getContext(); // Recent conversation
```

## Examples

Runnable example agents (support bot, research assistant, workflow router,
doc Q&A, Slack notifier, tracing) live in [examples/](examples/README.md) -
see [the examples index](examples/README.md) for what each one does and how
to run it.

### Example 1: Simple Chatbot

```typescript
import { AgentBuilder, AgentExecutor, OpenAIProvider } from '@loushy/build-ai-agent';

// Configure
const agent = new AgentBuilder()
  .setType('chatbot')
  .setPrompt('You are a helpful assistant.')
  .build();

const executor = new AgentExecutor({
  agent,
  sessionId: 'chat-1',
  llmProvider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY })
});

// Execute
const response = await executor.execute({
  messages: [{ role: 'user', content: 'What is the capital of France?' }]
});

console.log(response.response); // "The capital of France is Paris."
```

### Example 2: Agent with Tools

```typescript
import { AgentBuilder, AgentExecutor, ToolRegistry } from '@loushy/build-ai-agent';

// Register tools
const tools = new ToolRegistry();
tools.register({
  name: 'calculator',
  description: 'Perform calculations',
  parameters: z.object({
    expression: z.string()
  }),
  execute: async ({ expression }) => eval(expression)
});

// Build agent with tools
const agent = new AgentBuilder()
  .setType('smart-assistant')
  .setPrompt('You are a math assistant. Use the calculator tool when needed.')
  .addTool('calculator', { tool: 'calculator' })
  .build();

const executor = new AgentExecutor({
  agent,
  sessionId: 'math-1',
  toolRegistry: tools
});

const response = await executor.execute({
  messages: [{ role: 'user', content: 'What is 25 * 37?' }]
});
```

### Example 3: Workflow with Flows

```typescript
import { FlowBuilder, FlowExecutor } from '@loushy/build-ai-agent';

const flow = new FlowBuilder()
  .addNode({ id: '1', type: 'llm', data: { prompt: 'Generate ideas' } })
  .addNode({ id: '2', type: 'llm', data: { prompt: 'Evaluate ideas' } })
  .addNode({ id: '3', type: 'llm', data: { prompt: 'Select best idea' } })
  .addEdge('1', '2')
  .addEdge('2', '3')
  .build();

const executor = new FlowExecutor({ flow, llmProvider });
const result = await executor.execute({ input: 'Product ideas' });
```

## API Reference

### Core Classes

- **AgentBuilder** - Build and configure agents
- **AgentExecutor** - Execute agent conversations
- **ToolRegistry** - Manage available tools
- **FlowBuilder** - Build workflow graphs
- **FlowExecutor** - Execute workflows
- **MemoryManager** - Manage conversation context

### Providers

- **OpenRouterProvider** - Access 100+ models from OpenAI, Anthropic, Google, Meta, and more
- **OpenAIProvider** - Direct OpenAI integration
- **OllamaProvider** - Local LLM support
- **MockProvider** - Testing provider

### Utilities

- **EncryptionUtils** - Encryption/decryption
- **StorageService** - File storage
- **renderTemplate** - Template rendering
- **validateTokenQuotas** - Quota validation

For detailed API documentation, see the [API Overview](docs/api-overview.md), or run `npm run docs:build` to generate the full TypeDoc reference in `docs/api/`.

## Architecture

The SDK follows clean architecture principles:

```
┌─────────────────────────────────────┐
│         Your Application            │
│    (React, Vue, Express, etc.)      │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│     @loushy/build-ai-agent        │
│  ┌────────────────────────────┐    │
│  │  AgentBuilder/Executor     │    │
│  ├────────────────────────────┤    │
│  │  Tools  │ Flows  │ Memory  │    │
│  ├────────────────────────────┤    │
│  │       Core Engine          │    │
│  └────────────────────────────┘    │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│    Your Data Layer & LLM Provider   │
│   (Database, OpenAI, Ollama, etc.)  │
└─────────────────────────────────────┘
```

## Testing

```bash
# Run tests
pnpm test

# With coverage
pnpm test:coverage

# Type checking
pnpm typecheck
```

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Roadmap

- [ ] Additional LLM providers (Anthropic Claude, Google Gemini)
- [ ] More database adapters (Prisma, MongoDB)
- [ ] Advanced flow patterns
- [ ] Multi-agent collaboration
- [ ] Plugin system

## Support

- 📖 [Documentation](https://docs.loushy.dev)

## License

MIT © [Build AI Agent](LICENSE)
