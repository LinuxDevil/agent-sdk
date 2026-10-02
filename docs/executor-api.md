# The executor API

`createAgent()` is the recommended entry point (see the [Quick Start](./quick-start.md)). This page is for code that needs the lower-level options it does not take. To move existing executor code over to `createAgent()`, see [Migrating to createAgent()](./migrating-to-create-agent.md).

## `AgentBuilder` and `AgentExecutor`

`createAgent()` is a thin wrapper over `AgentBuilder` and the static
`AgentExecutor.execute()`. Use them directly only for what `createAgent()` does not
take: `temperature` and `maxTokens`, and a `TraceExporter` for tracing
(`exporter`, `captureContent`). `createAgent()` already takes `maxSteps`,
`limits`, `onEvent`, approvals, `store` (checkpoints), `hooks` and `compaction`. `AgentExecutor` is a static API - there is no
`new AgentExecutor()`.

```ts
import {
  AgentBuilder,
  AgentExecutor,
  createMockProvider,
} from '@lousho/build-ai-agent';

const agent = AgentBuilder.create()
  .setName('Customer Support Agent')
  .setPrompt('You are a helpful customer support assistant.')
  .build();

const events: string[] = [];
const result = await AgentExecutor.execute({
  agent,
  input: 'My order arrived damaged.',
  provider: createMockProvider({ responses: ["I'm sorry to hear that - what's your order number?"] }),
  maxSteps: 5,
  onAgentEvent: (event) => events.push(event.type),
});

console.log(result.text);
console.log(result.usage.totalTokens, result.finishReason, result.steps);
console.log(events); // includes 'run.start' and 'run.done'
```

## Sharing tools with `ToolRegistry`

*Advanced: `ToolRegistry`.* To share tools across agents or register raw
`ToolDescriptor`s, use `registry.register(tool)` for a defined tool or
`registry.register(name, descriptor)` for a descriptor. Pass the registry as
`toolRegistry` to `AgentExecutor.execute()`. See
[Tools](./tools.md#advanced-toolregistry) for a full example.

## Options of `AgentExecutor.execute()`

`AgentExecutor` is static: call `AgentExecutor.execute(options)`. Only
`agent`, `input` and `provider` are required. Commonly used options:

| Option                                  | Description                                                     |
| --------------------------------------- | --------------------------------------------------------------- |
| `agent`                                 | An `AgentConfig`, usually built with `AgentBuilder`.            |
| `input`                                 | A user message string, or a `Message[]` conversation.            |
| `provider`                              | The `LLMProvider` to generate with.                             |
| `toolRegistry`                          | A `ToolRegistry` holding the tools the agent config refers to.  |
| `maxSteps`                              | Upper bound on LLM/tool steps.                                  |
| `limits`                                | Token, cost, time and step budgets of the run; see [Budgets](./configuration.md#budgets). |
| `temperature`, `maxTokens`              | Generation parameters.                                          |
| `onAgentEvent`                          | Listener for the run's `AgentEvent`s (`run.start`, `tool.start`, `run.done`, ...); see [Streaming](./streaming.md#listening-without-iterating). |
| `approvalStore`, `sessionId`            | Human-in-the-loop approvals (see `resumeAfterApproval()`).       |
| `checkpointStore`                       | Persist/resume execution checkpoints.                           |
| `exporter`                              | A `TraceExporter` for tracing spans (OpenTelemetry GenAI conventions, see [observability](observability.md)). |
| `captureContent`, `redactContent`       | Record message/tool content on `gen_ai.*` span attributes (opt-in) / omit the deprecated content attributes. |
| `onLLMRequest`, `onLLMResponse`, `onToolCall`, `onToolResult` | Observability hooks.                |

It resolves to an `ExecutionResult`: `{ text, messages, toolCalls, usage,
finishReason, steps, approvalId? }`.
