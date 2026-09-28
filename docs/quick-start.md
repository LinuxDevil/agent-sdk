# Quick Start

Every TypeScript snippet on this page is a complete, standalone ES module
(`.mts`) that runs as-is with the SDK's built-in mock provider - no API key
needed. They are executed against a locally packed build of the SDK by
`npx tsx scripts/verify-docs-snippets.ts`, so they are kept in sync with the
real API.

Install first (see [Installation](./installation.md)):

```bash
npm install @loushy/build-ai-agent ai zod
npm install @ai-sdk/openai@^0.0.42 @ai-sdk/anthropic@^0.0.42 ollama-ai-provider@^1.2.0
```

## 1. One-liner agent with `createAgent()`

`createAgent()` is the zero-config entry point: a prompt and a provider in, a
`{ send }` agent out.

```ts
import { createAgent, createMockProvider } from '@loushy/build-ai-agent';

const agent = createAgent({
  prompt: 'You are a helpful assistant.',
  provider: createMockProvider({ responses: ['Hello! How can I help you today?'] }),
});

const result = await agent.send('Hi there');
console.log(result.text); // "Hello! How can I help you today?"
```

## 2. Switching to a real provider

`resolveProvider('<provider>/<model>')` builds a real provider, reading its
credential from the environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`, or `OLLAMA_BASE_URL` for Ollama). This snippet uses
OpenAI when `OPENAI_API_KEY` is set and falls back to the mock provider
otherwise - the same pattern the runnable [examples](../examples/README.md)
use.

```ts
import { createAgent, createMockProvider, resolveProvider } from '@loushy/build-ai-agent';

const provider = process.env.OPENAI_API_KEY
  ? resolveProvider('openai/gpt-4o-mini')
  : createMockProvider({ responses: ['Paris.'] });

const agent = createAgent({
  name: 'geography-bot',
  prompt: 'Answer geography questions in one word.',
  provider,
});

const result = await agent.send('What is the capital of France?');
console.log(result.text);
```

## 3. Adding tools

Tools are passed to `createAgent()` keyed by the name the agent calls them
by. The SDK ships several built-in tools (`currentDateTool`, `dayNameTool`,
`httpTool`, ...). The mock provider simulates a tool call whenever the user
message mentions a tool's name, so this snippet exercises a real tool round
trip without an LLM.

```ts
import { createAgent, createMockProvider, currentDateTool } from '@loushy/build-ai-agent';

const agent = createAgent({
  prompt: 'You are a scheduling assistant. Use tools when helpful.',
  provider: createMockProvider({ responses: ['Let me check.', 'Here is the date you asked for.'] }),
  tools: { current_date: currentDateTool },
});

const result = await agent.send('Please call current_date for me');
console.log(result.toolCalls.map((call) => call.function.name)); // [ 'current_date' ]
console.log(result.text);
```

## 4. Full control: `AgentBuilder` + `AgentExecutor`

`createAgent()` is a thin wrapper over `AgentBuilder` and the static
`AgentExecutor.execute()`. Use them directly when you need the full set of
execution options (`maxSteps`, `temperature`, `onEvent`, approvals,
checkpoints, tracing, ...). `AgentExecutor` is a static API - there is no
`new AgentExecutor()`.

```ts
import {
  AgentBuilder,
  AgentExecutor,
  AgentType,
  createMockProvider,
} from '@loushy/build-ai-agent';

const agent = AgentBuilder.create()
  .setType(AgentType.SmartAssistant)
  .setName('Customer Support Agent')
  .setPrompt('You are a helpful customer support assistant.')
  .build();

const events: string[] = [];
const result = await AgentExecutor.execute({
  agent,
  input: 'My order arrived damaged.',
  provider: createMockProvider({ responses: ["I'm sorry to hear that - what's your order number?"] }),
  maxSteps: 5,
  onEvent: (event) => events.push(event.type),
});

console.log(result.text);
console.log(result.usage.totalTokens, result.finishReason, result.steps);
console.log(events); // includes 'start' and 'finish'
```

## 5. Declarative agents: spec files

An agent can also be described as plain data - an `AgentSpec` - and turned
into a live agent with `specToAgent()`. The same shape can be written as a
YAML or JSON file and loaded with `loadSpec()`.

```ts
import { specToAgent, agentSpecSchema } from '@loushy/build-ai-agent';

const spec = agentSpecSchema.parse({
  name: 'support-bot',
  prompt: 'You are a friendly support agent.',
  provider: { type: 'mock', model: 'mock-1' },
  tools: ['current-date'],
});

const agent = specToAgent(spec);
const result = await agent.send('Hello!');
console.log(result.text);
```

Saved as `agent.yaml`:

```yaml
name: support-bot
prompt: You are a friendly support agent.
provider:
  type: mock
  model: mock-1
tools:
  - current-date
```

the same spec runs in the local dev server (chat UI at `/`, `POST /chat`,
hot reload on save) and builds into a deployable server:

```bash
npx loushy dev agent.yaml
npx loushy build --target=node-server --agent=agent.yaml
```

## Next steps

- [Configuration](./configuration.md) - every spec field, provider env var and CLI flag.
- [Deployment](./deployment.md) - `loushy build` targets (Node server, Docker, Cloudflare Workers).
- [API Overview](./api-overview.md) - the main exports and where to find full API reference.
- [Examples](../examples/README.md) - runnable example agents.
