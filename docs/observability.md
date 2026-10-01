# Tracing and observability

`AgentExecutor.execute()` and `FlowExecutor.execute()` emit spans through a
`TraceExporter`. Span names and attributes follow the
[OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/),
so GenAI-aware observability backends can recognise them without custom
mapping.

> **Stability.** The GenAI conventions are in `Development` status (not
> stable). Attribute names have changed between versions of the spec before
> (for example `gen_ai.system` became `gen_ai.provider.name`) and may change
> again. This SDK follows the spec as retrieved on 2026-10-01 from the
> [semantic-conventions-genai repository](https://github.com/open-telemetry/semantic-conventions-genai)
> (where the conventions now live). Pin your SDK version if dashboards depend
> on these names.

## Quick start

```ts
import { AgentExecutor, type TraceExporter } from '@loushy/build-ai-agent';

const exporter: TraceExporter = {
  onSpanStart: (span) => console.log('[start]', span.kind, span.name),
  onSpanEnd: (span) => console.log('[end]', span.name, span.status?.code ?? 'ok', span.attributes),
};

await AgentExecutor.execute({ agent, input, provider, toolRegistry, exporter });
```

For real OpenTelemetry spans, import `createOtelTraceExporter()` from
`@loushy/build-ai-agent/otel` (needs the optional peer dependency
`@opentelemetry/api` and a registered `TracerProvider`). It carries span kind
and error status over to OpenTelemetry. See `examples/tracing`
(`npm run example:tracing:console`, `npm run example:tracing:otel`).

## Span tree

```
invoke_agent {agent name}          INTERNAL
  chat {model}                     CLIENT     one per provider.generate() call
  execute_tool {tool name}         INTERNAL   one per tool call
```

A flow run (`FlowExecutor.execute`) produces:

```
invoke_workflow {flow name}        INTERNAL
  flow.node {node type}            INTERNAL   one per node execution, nested like the flow
    chat {model}                   CLIENT     inside an llmCall node
    execute_tool {tool name}       INTERNAL   inside a toolCall node
```

To nest a flow under an agent span, pass that span's id as `parentSpanId`
(`withSpan` hands the span to its callback); the flow span then becomes its
child.

## Attributes

Constants for every name live in `src/execution/semconv.ts` (exported as
`GenAiAttr`, `GenAiOperation`, `ErrorAttr`, `FlowAttr`, `LegacyAttr`).

### Agent run: `invoke_agent {agent name}`

| Attribute | Value |
| --- | --- |
| `gen_ai.operation.name` | `invoke_agent` |
| `gen_ai.agent.name` | The agent's `name` |
| `gen_ai.agent.id` | The agent's `id`, when set |
| `gen_ai.provider.name` | The provider's `name` |
| `gen_ai.conversation.id` | `sessionId`, when set |

### Model call: `chat {model}` (CLIENT)

| Attribute | Value |
| --- | --- |
| `gen_ai.operation.name` | `chat` |
| `gen_ai.provider.name` | The provider's `name` |
| `gen_ai.request.model` | The requested model |
| `gen_ai.request.temperature`, `gen_ai.request.max_tokens` | When set |
| `gen_ai.response.model` | When the provider reports it |
| `gen_ai.response.finish_reasons` | e.g. `["stop"]`, `["tool_call"]` |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | Token usage |

### Tool call: `execute_tool {tool}`

| Attribute | Value |
| --- | --- |
| `gen_ai.operation.name` | `execute_tool` |
| `gen_ai.tool.name` | The tool name |
| `gen_ai.tool.call.id` | The model's tool-call id (agent runs) |
| `gen_ai.tool.description` | The tool's description, when it has one |
| `gen_ai.tool.type` | `function` |
| `gen_ai.agent.name`, `gen_ai.conversation.id` | The calling agent / session |

### Flows

The GenAI spec defines no convention for flow nodes, so node spans use the
`loushy.flow.*` namespace. The run span uses the spec's workflow convention.

| Span | Attribute | Value |
| --- | --- | --- |
| `invoke_workflow {name}` | `gen_ai.operation.name` | `invoke_workflow` |
| | `gen_ai.workflow.name` | The flow's `name` |
| | `loushy.flow.code` | The flow's `code` |
| | `loushy.flow.outcome` | `success` or `error` |
| `flow.node {type}` | `loushy.flow.node.id` | The node's id |
| | `loushy.flow.node.type` | The node type (`sequence`, `llmCall`, ...) |
| | `loushy.flow.outcome` | `success` or `error` |

### Errors

A failed span gets `error.type` and an error span status (OpenTelemetry
`ERROR`, message = the error message). `error.type` is the thrown error's
`name` (`_OTHER` when a non-`Error` is thrown). A tool call that returns an
error to the model (`isError`) is marked `error.type = tool_error`.

## Message and argument content is opt-in

Prompts, model output and tool arguments/results are sensitive and large, so
the `gen_ai.*` content attributes are **never recorded by default**. Opt in
per run:

```ts
import { AgentExecutor, type TraceExporter } from '@loushy/build-ai-agent';

declare const exporter: TraceExporter;

await AgentExecutor.execute({ agent, input, provider, exporter, captureContent: true });
```

Flows take the same flag on their context (`captureContent`). When
`captureContent` is not set, the `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`
environment variable (the name the spec uses as its example) turns it on.
An explicit `captureContent: false` always wins.

With it on, content is recorded as JSON strings (the spec's fallback for
spans) in the spec's message schema:

| Attribute | On | Content |
| --- | --- | --- |
| `gen_ai.input.messages` | `invoke_agent`, `chat` | `[{ role, parts: [{ type: 'text', content }, { type: 'tool_call', id, name, arguments }, { type: 'tool_call_response', id, response }] }]` |
| `gen_ai.system_instructions` | `chat` | `[{ type: 'text', content }]` |
| `gen_ai.output.messages` | `chat` | `[{ role: 'assistant', parts: [...] }]` |
| `gen_ai.tool.call.arguments` | `execute_tool` | The arguments as JSON |
| `gen_ai.tool.call.result` | `execute_tool` | The result as JSON (not set when the tool failed) |

## Deprecated attribute names

Before the GenAI conventions, spans used ad-hoc names and the span names
`agent.run`, `llm.generate` and `tool.call`. The old attribute names are still
emitted next to the new ones so existing dashboards keep working, but they are
**deprecated** and will be removed in a future major version. Span names
changed (to what the spec requires); update queries that matched on them.

| Deprecated | Use instead |
| --- | --- |
| span `agent.run` | span `invoke_agent {name}`, `gen_ai.operation.name = invoke_agent` |
| span `llm.generate` | span `chat {model}`, `gen_ai.operation.name = chat` |
| span `tool.call` | span `execute_tool {tool}`, `gen_ai.operation.name = execute_tool` |
| `model` | `gen_ai.request.model` |
| `promptTokens` | `gen_ai.usage.input_tokens` |
| `completionTokens` | `gen_ai.usage.output_tokens` |
| `totalTokens` | (sum the two usage attributes) |
| `finishReason` | `gen_ai.response.finish_reasons` (an array; `tool_calls` is now `tool_call`) |
| `toolName` | `gen_ai.tool.name` |
| `error` (message on a thrown error; boolean on `execute_tool`) | `error.type` and the span status |
| `input`, `prompt`, `args`, `result` | `gen_ai.input.messages`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` (opt-in, see above) |

The deprecated content attributes (`input`, `prompt`, `args`, `result`) keep
their old behavior: they are recorded unless `redactContent: true`. Set
`redactContent: true` if you want no content on spans unless you opt in with
`captureContent`.

## Backends

Any backend that ingests OpenTelemetry traces (OTLP) receives these spans.
Backends and tools that understand the GenAI semantic conventions can render
them as LLM, agent and tool calls with token usage; others show them as
ordinary spans with attributes. Which conventions a given backend supports,
and which version of them, varies; check its documentation.
