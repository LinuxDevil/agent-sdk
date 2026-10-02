# The executor API

`createAgent()` is the recommended entry point (see the [Quick Start](./quick-start.md)). This page is for code that needs the lower-level options it does not take.

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
[Tools](./tools.md#toolregistry) for a full example.
