# Quick Start

This page takes you from a one-line agent to tools, streaming, sessions, an
approval and an offline test. Every snippet after the first runs as-is with no
API key, on the SDK's built-in mock provider.

## Start a new project

The fastest way in is one command, which creates a runnable project (an
agent, an example tool, an offline test, a `.env.example` for your provider),
installs its dependencies and runs `git init`:

```bash
npx lousho init my-agent
cd my-agent
cp .env.example .env     # put your API key in .env
npm run dev              # chat with your agent in the terminal
npm test                 # offline tests: no API key needed
```

`npm create lousho-agent my-agent` is equivalent, and so is
`npx @lousho/build-ai-agent init my-agent` when the SDK is not installed yet
(a bare `npx lousho` only finds the `lousho` command once the SDK is in your
`node_modules`). Without arguments, `init` asks for the directory, provider and
template; `lousho init --help` lists every flag.

Prefer to add the SDK to an existing project? Install it by hand (see
[Installation](./installation.md)):

```bash
npm install @lousho/build-ai-agent ai@^7.0.0 zod
npm install @ai-sdk/openai@^4.0.0 @ai-sdk/anthropic@^4.0.0
```

That is the current `ai` major; for Ollama, use `ai@^7.0.0` with
`ollama-ai-provider-v2@^4.0.0` and zod 4 (see [the pairings](./installation.md#provider-packages)).

## 1. Hello world

`createAgent()` is the zero-config entry point: a `provider/model` string and
instructions in, a `{ send }` agent out. The API key is read from the
provider's conventional environment variable (`OPENAI_API_KEY` here;
`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` or `OLLAMA_BASE_URL` for the other
providers). The `vendor/` model prefix chooses the provider; with OpenRouter
use `openrouter/<vendor>/<model>` (e.g. `openrouter/openai/gpt-4o-mini`).

```ts no-run
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini', instructions: 'You are a helpful assistant.' });
const { text } = await agent.send('Hello!');
console.log(text);
```

Leave `model` out to let the environment decide: `LOUSHO_MODEL` (a
`provider/model` string) if set, otherwise the first of `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL` that is present.
If a key is missing or the prefix is misspelled, the error tells you exactly
what to set or fix. `instructions` is optional; `prompt` is accepted as an
alias for it.

## 2. Add a tool

Define a tool with `defineTool()`: the `execute` and `needsApproval` arguments
are typed from the zod `input`, and the result goes straight into
`createAgent({ tools: [...] })`. The mock provider simulates a tool call
whenever the user message mentions a tool's name, so this snippet exercises a
real tool round trip without an LLM.

```ts
import { createAgent, createMockProvider, defineTool } from '@lousho/build-ai-agent';
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

Names must be 1-64 characters of letters, digits, `_` or `-`. See
[Tools](./tools.md) for validation, errors and the built-in tools.

## 3. Stream the answer

`agent.stream()` runs the agent like `send()` and returns an `AgentRun`: iterate
it for typed events (model text as it arrives, tool calls, step boundaries),
and `await run.result` for the same result `send()` returns.

```ts
import { createAgent, createMockProvider } from '@lousho/build-ai-agent';

const agent = createAgent({
  prompt: 'You are a helpful assistant.',
  provider: createMockProvider({ responses: ['Streaming works word by word.'] }),
});

const run = agent.stream('Tell me something.');
for await (const event of run) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
process.stdout.write('\n');

const result = await run.result;
console.log(result.finishReason); // "stop"
```

See [Streaming](./streaming.md) for the full event list, cancellation and
sending the events to a browser.

## 4. Remember the conversation

`agent.send()` starts from an empty history on every call. `agent.session()`
keeps the transcript and passes it to the model on each `send()`.

```ts
import { createAgent, createMockProvider } from '@lousho/build-ai-agent';

const agent = createAgent({
  prompt: 'You are a helpful assistant.',
  provider: createMockProvider({ responses: ['Nice to meet you, Ali.', 'Your name is Ali.'] }),
});

const session = agent.session();
await session.send('My name is Ali.');
const { text } = await session.send('What is my name?');

console.log(text);
console.log(session.messages.length); // 4: two user messages and two replies
```

Pass a store to keep sessions across restarts; see [Sessions](./sessions.md).

## 5. Ask before a risky action

Flag a tool `needsApproval` and the run pauses before calling it. `send()`
resolves with `finishReason: 'awaiting-approval'` and an `approvalId`; your code
(or a human) then approves or rejects the call and the run continues. Here
`mockModel` from `@lousho/build-ai-agent/testing` scripts the model's turns
exactly, so the tool call is certain.

```ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send an email',
  input: z.object({ to: z.string() }),
  needsApproval: true,
  execute: async ({ to }) => `sent to ${to}`,
});

const agent = createAgent({
  instructions: 'You send emails.',
  provider: mockModel([
    { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' } }] },
    { text: 'Sent.' },
  ]),
  tools: [sendEmail],
});

const paused = await agent.send('Email the report to sam@example.com');
console.log(paused.finishReason); // "awaiting-approval"

const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
console.log(result.text); // "Sent."
```

Pass `approved: false` (and a `note`) to reject the call instead. See
[Approvals](./approvals.md) for predicates, stores and deciding from another
process.

## 6. Test it offline

The agent from the last step is already testable: `mockModel` records every
request the agent made, so you can assert on what the model was sent as well as
on the result. No network, no key.

```ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

let sent: string | undefined;
const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send an email',
  input: z.object({ to: z.string() }),
  needsApproval: true,
  execute: async ({ to }) => {
    sent = to;
    return `sent to ${to}`;
  },
});

const model = mockModel([
  { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' } }] },
  { text: 'Sent.' },
]);
const agent = createAgent({ instructions: 'You send emails.', provider: model, tools: [sendEmail] });

const paused = await agent.send('Email the report to sam@example.com');
const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`Assertion failed: ${message}`);
}
check(result.text === 'Sent.', 'final answer');
check(sent === 'sam@example.com', 'the tool ran with the approved arguments');
check(model.calls.length === 2, 'the model was called twice');
model.assertExhausted(); // throws if a scripted turn was never used
console.log('ok');
```

In a real project, put the same assertions in a vitest or Jest test. See
[Testing](./testing.md) for tool-call flows, error turns and `recordReplay`.

## 7. Custom provider

`model: 'provider/model'` is the shortcut; pass `provider` instead when you
have your own `LLMProvider` or want the mock for tests.
`resolveProvider('<provider>/<model>')` is the function `model` uses under the
hood. This snippet uses OpenAI when `OPENAI_API_KEY` is set and falls back to
the mock provider otherwise - the same pattern the runnable
[examples](../examples/README.md) use.

```ts
import { createAgent, createMockProvider, resolveProvider } from '@lousho/build-ai-agent';

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

## 8. Declarative agents: spec files

An agent can also be described as plain data - an `AgentSpec` - and turned
into a live agent with `specToAgent()`. The same shape can be written as a
YAML or JSON file and loaded with `loadSpec()`.

```ts
import { specToAgent, agentSpecSchema } from '@lousho/build-ai-agent';

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
npx lousho dev agent.yaml
npx lousho build --target=node-server --agent=agent.yaml
```

## Advanced: the executor API

`createAgent()` is the recommended entry point. It sits on top of
`AgentBuilder` and the static `AgentExecutor.execute()`, which take a few
lower-level options `createAgent()` does not, such as `temperature` and
`maxTokens`. See [The executor API](./executor-api.md).

## Next steps

- [Configuration](./configuration.md) - every spec field, provider env var and CLI flag.
- [Deployment](./deployment.md) - `lousho build` targets (Node server, Docker, Cloudflare Workers).
- [API Overview](./api-overview.md) - the main exports and where to find full API reference.
- [Examples](../examples/README.md) - runnable example agents.
