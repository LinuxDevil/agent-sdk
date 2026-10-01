# Quick Start

Every TypeScript snippet on this page is a complete, standalone ES module
(`.mts`). They are type-checked and executed against a locally packed build of
the SDK by `npx tsx scripts/verify-docs-snippets.ts`, so they are kept in sync
with the real API. All of them run as-is with the SDK's built-in mock
provider - no API key needed - except the first, which talks to a real model
and is therefore only type-checked.

Install first (see [Installation](./installation.md)):

```bash
npm install @loushy/build-ai-agent ai zod
npm install @ai-sdk/openai@^0.0.42 @ai-sdk/anthropic@^0.0.42 ollama-ai-provider@^1.2.0
```

## 1. Hello world in five lines

`createAgent()` is the zero-config entry point: a `provider/model` string and
instructions in, a `{ send }` agent out. The API key is read from the
provider's conventional environment variable (`OPENAI_API_KEY` here;
`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` or `OLLAMA_BASE_URL` for the other
providers).

```ts no-run
import { createAgent } from '@loushy/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini', instructions: 'You are a helpful assistant.' });
const { text } = await agent.send('Hello!');
console.log(text);
```

Leave `model` out to let the environment decide: `LOUSHY_MODEL` (a
`provider/model` string) if set, otherwise the first of `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL` that is present.
If a key is missing or the prefix is misspelled, the error tells you exactly
what to set or fix. `instructions` is optional; `prompt` is accepted as an
alias for it.

## 2. When you need a custom provider

Pass a provider instance instead of `model` when you have your own
`LLMProvider`, want the mock provider for tests, or need extra provider
config. This one needs no API key:

```ts
import { createAgent, createMockProvider } from '@loushy/build-ai-agent';

const agent = createAgent({
  instructions: 'You are a helpful assistant.',
  provider: createMockProvider({ responses: ['Hello! How can I help you today?'] }),
});

const result = await agent.send('Hi there');
console.log(result.text); // "Hello! How can I help you today?"
```

`resolveProvider('<provider>/<model>')` is the function `model` uses under
the hood; call it yourself when you want the provider object, as in this
snippet, which uses OpenAI when `OPENAI_API_KEY` is set and falls back to the
mock provider otherwise - the same pattern the runnable
[examples](../examples/README.md) use.

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

Define a tool with `defineTool()`: the `execute` and `needsApproval` arguments
are typed from the zod `input`, and the result goes straight into
`createAgent({ tools: [...] })`. The mock provider simulates a tool call
whenever the user message mentions a tool's name, so this snippet exercises a
real tool round trip without an LLM.

```ts
import { createAgent, createMockProvider, defineTool } from '@loushy/build-ai-agent';
import { z } from 'zod';

const currentDate = defineTool({
  name: 'current_date',
  description: 'Get the current date',
  input: z.object({}),
  async execute() {
    return { date: new Date().toISOString().slice(0, 10) };
  },
});

const agent = createAgent({
  prompt: 'You are a scheduling assistant. Use tools when helpful.',
  provider: createMockProvider({ responses: ['Let me check.', 'Here is the date you asked for.'] }),
  tools: [currentDate],
});

const result = await agent.send('Please call current_date for me');
console.log(result.toolCalls.map((call) => call.function.name)); // [ 'current_date' ]
console.log(result.text);
```

Names must be 1-64 characters of letters, digits, `_` or `-`. The SDK also
ships built-in tools (`currentDateTool`, `dayNameTool`, `httpTool`, ...) that
you pass keyed by name: `tools: { current_date: currentDateTool }`.

*Advanced: `ToolRegistry`.* To share tools across agents or register raw
`ToolDescriptor`s, use `registry.register(tool)` for a defined tool or
`registry.register(name, descriptor)` for a descriptor.

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
