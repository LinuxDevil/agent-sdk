# Migrating from the Vercel AI SDK

This page is for code built on the Vercel AI SDK's agent loop: `generateText({ tools })`
or `streamText({ tools })` with a step limit, or `new ToolLoopAgent({ ... })`. You can keep
your models, your tools and your `useChat` front end. Three adapters bring them over
without a rewrite:

| You have | Use | Covered in |
| --- | --- | --- |
| An AI SDK model (`openai('gpt-4o')`, `google(...)`, `bedrock(...)`, the Gateway) | `fromAiSdk(model)` | [Models](#models-fromaisdk) |
| AI SDK tools (`tool({ ... })` or plain `{ description, inputSchema, execute }` objects) | `fromAiSdkTools(tools)` | [Tools](#tools-fromaisdktools) |
| A `useChat` front end | `toUIMessageStreamResponse()` and `fromUIMessages()` | [useChat](#usechat) |

What you get in return is what `createAgent()` adds on top of a model loop: durable
approvals that survive a restart, sessions in memory, files or SQLite, crash resume,
budgets, permission rules, sub-agents and handoffs, MCP servers, tracing and evals.

## Mapping

| AI SDK | Lousho |
| --- | --- |
| `new ToolLoopAgent({ model, instructions, tools })` | `createAgent({ provider: fromAiSdk(model), instructions, tools: fromAiSdkTools(tools) })` |
| `generateText({ model, system, prompt, tools, stopWhen })` | `await agent.send(prompt)`; `system` is `instructions` |
| `streamText({ ... })` / `agent.stream()` | `agent.stream(prompt)`: `for await` over typed events, or `await run.result` |
| `result.text` | `result.text` |
| `result.steps`, `onStepFinish` | `step.start` / `step.done` / `tool.done` events (`onEvent`, or iterate `agent.stream()`) ([Stream events](./stream-events.md)) |
| `result.usage` / `totalUsage` | `result.usage` (tokens of every call, plus `costUsd` for priced models) ([Models and cost](./models-and-cost.md)) |
| `stopWhen: stepCountIs(n)` / v4 `maxSteps: n` | `maxSteps: n`; token, cost and time budgets with `limits` ([Configuration](./configuration.md#budgets)) |
| `temperature`, `maxOutputTokens`, `toolChoice`, ... | `modelSettings: { temperature, maxTokens, toolChoice, ... }` |
| `output: Output.object({ schema })` / `experimental_output` | `output: schema`, read as `result.object` ([Structured output](./structured-output.md)) |
| `messages: [...]` (you keep the history) | `agent.session({ id })` keeps it for you, or pass the messages to `send()` ([Sessions](./sessions.md)) |
| `abortSignal` | `send(input, { signal })` |
| `tool({ needsApproval })` and `addToolApprovalResponse` | `needsApproval` (kept by `fromAiSdkTools()`); the run pauses with `finishReason: 'awaiting-approval'` and continues with `agent.approvals.resolve()`, also after a restart ([Approvals](./approvals.md)) |
| Provider tools (`openai.tools.webSearch()`) | `webSearch()`, `codeInterpreter()`, `fileSearch()`, `hostedTool()` ([Hosted tools](./hosted-tools.md)) |
| `experimental_createMCPClient()` | `createAgent({ mcpServers })` ([MCP](./mcp.md)) |

## Models: fromAiSdk()

`fromAiSdk(model)` wraps any AI SDK `LanguageModel` as the agent's provider, so a model
you already configured (keys, base URL, provider options) works as it is:

```ts no-run
import { createOpenAI } from '@ai-sdk/openai';
import { createAgent, fromAiSdk } from '@lousho/build-ai-agent';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const agent = createAgent({ provider: fromAiSdk(openai.chat('gpt-4o-mini')), instructions: 'You are helpful.' });
```

For the built-in vendors a model string is shorter: `createAgent({ model: 'openai/gpt-4o-mini' })`.
See [Providers](./providers.md#any-ai-sdk-model-fromaisdk) for the options and which
`ai` majors are supported.

## Tools: fromAiSdkTools()

`fromAiSdkTools()` takes the same record you pass to `generateText({ tools })` or
`ToolLoopAgent`, and returns Lousho tools; each key becomes the tool's name:

```ts no-verify
import { tool } from 'ai';
import { z } from 'zod';
import { createAgent, fromAiSdk, fromAiSdkTools } from '@lousho/build-ai-agent';

const weather = tool({
  description: 'Get the weather in a city',
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }, { abortSignal }) => fetchWeather(city, abortSignal),
});
const sendEmail = tool({
  description: 'Send an email',
  inputSchema: z.object({ to: z.string(), body: z.string() }),
  needsApproval: async ({ to }) => !to.endsWith('@example.com'),
  execute: async ({ to, body }) => mailer.send(to, body),
});

const agent = createAgent({
  provider: fromAiSdk(model),
  instructions: 'You are a helpful assistant.',
  tools: fromAiSdkTools({ weather, sendEmail }),
});
```

The conversion does not import `ai`, so a tool works whatever `ai` version built it,
and a plain object works too. This one runs offline:

```ts
import { z } from 'zod';
import { createAgent, fromAiSdkTools } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const tools = fromAiSdkTools({
  weather: {
    description: 'Get the weather in a city',
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }: { city: string }) => `Sunny in ${city}`,
  },
});
const agent = createAgent({
  provider: mockModel([{ toolCalls: [{ name: 'weather', args: { city: 'Paris' } }] }, 'It is sunny in Paris.']),
  tools,
});
const result = await agent.send('Weather in Paris?');
console.log(result.text); // It is sunny in Paris.
```

How each part of an AI SDK tool is carried over:

| AI SDK tool | Lousho tool |
| --- | --- |
| `inputSchema` (`ai` 5+) or `parameters` (`ai` 4), a zod 3 / zod 4 schema or a Standard Schema | used as it is |
| `inputSchema: jsonSchema({...})`, or a plain JSON Schema | converted to zod (the converter MCP tools use); the wrapper's own `validate` still runs before `execute` |
| `execute(input, { toolCallId, messages, abortSignal })` | called with Lousho's call id, the run's abort signal, and the transcript as Lousho `Message`s (not AI SDK `ModelMessage`s) |
| An `execute` that throws | a tool error the model sees; the run continues |
| An `execute` that returns an async iterable (preliminary results) | each value is a `tool.partial` event; the last is the result |
| `needsApproval: true` or a function of the input | `needsApproval`: the run pauses durably until `agent.approvals.resolve()` |
| A `description` function (`ai` 7) | called once with an empty context |
| No `execute` (a client-side tool) | rejected with `LOUSHO_CONFIG_INVALID`: give it an `execute`, or use `needsApproval` / the [`ask_question` tool](./approvals.md#asking-the-user-a-question) |
| A provider-defined tool | rejected: use [hosted tools](./hosted-tools.md) |

`experimental_context`, `onInputStart` / `onInputDelta` / `onInputAvailable` and
`toModelOutput` are not carried over. For a new tool, prefer `defineTool()`
([Tools](./tools.md)): it also takes `timeoutMs`, `annotations`, `editsFiles` and
`deferLoading`.

## useChat

A `useChat` front end keeps working: the route returns the agent's run as a UI message
stream.

```ts no-run
import { createAgent, fromUIMessages, memoryStore, toUIMessageStreamResponse, type UIMessageLike } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini', instructions: 'You are helpful.', store: memoryStore() });

// app/api/chat/route.ts
export async function POST(request: Request): Promise<Response> {
  const { id, messages } = (await request.json()) as { id: string; messages: UIMessageLike[] };
  return toUIMessageStreamResponse(agent.session({ id }).stream(fromUIMessages(messages, { lastUserOnly: true })));
}
```

Approvals, tool parts and the client side are in [AI SDK UI](./ai-sdk-ui.md); a ready
App Router route is `createRouteHandler(agent)` ([Next.js](./nextjs.md)).

## See also

- [Comparison](./comparison.md): where Lousho and the AI SDK differ, including where Lousho is weaker.
- [Migrating to createAgent()](./migrating-to-create-agent.md) is about Lousho's own older `AgentBuilder` / `AgentExecutor` API, not the AI SDK.
