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

Pass an `exporter` to `createAgent()`; every run of the agent (`send()`,
`stream()`, session turns, `resume()` and runs continued by
`agent.approvals.resolve()`) is traced, sub-agents included. To keep traces
on disk and browse them with `npx lousho traces`, use `fileTraceExporter()`
(see [Local traces](#local-traces)). The `vendor/` model prefix chooses the
provider; with OpenRouter use `openrouter/<vendor>/<model>` (e.g.
`openrouter/openai/gpt-4o-mini`).

```ts
import { createAgent } from '@lousho/build-ai-agent';
import { fileTraceExporter } from '@lousho/build-ai-agent/traces';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  instructions: 'You are a helpful assistant.',
  exporter: fileTraceExporter(), // writes .lousho/traces/<day>/<traceId>.jsonl
});
```

Any object with `onSpanStart` and `onSpanEnd` is an exporter.

#### Advanced: the executor API

With the executor, pass the exporter to `AgentExecutor.execute()`:

```ts
import { AgentExecutor, type TraceExporter } from '@lousho/build-ai-agent';

const exporter: TraceExporter = {
  onSpanStart: (span) => console.log('[start]', span.kind, span.name),
  onSpanEnd: (span) => console.log('[end]', span.name, span.status?.code ?? 'ok', span.attributes),
};

await AgentExecutor.execute({ agent, input, provider, toolRegistry, exporter });
```

For real OpenTelemetry spans, import `createOtelTraceExporter()` from
`@lousho/build-ai-agent/otel` (needs the optional peer dependency
`@opentelemetry/api` and a registered `TracerProvider`). It carries span kind
and error status over to OpenTelemetry. See `examples/tracing`
(`npm run example:tracing:console`, `npm run example:tracing:otel`, which also prints metrics).

## Span tree

```
invoke_agent {agent name}          INTERNAL
  chat {model}                     CLIENT     one per provider.generate() call
  execute_tool {tool name}         INTERNAL   one per tool call
```

A run continued after an approval (`agent.approvals.resolve()`) is a trace of its
own: its `invoke_agent` span holds the approved call's `execute_tool` span
(first, as the call runs before the model is called again), then the `chat`
spans of the rest of the run. A rejected call has no `execute_tool` span.

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
`GenAiAttr`, `GenAiOperation`, `GenAiMetric`, `ErrorAttr`, `FlowAttr`, `SdkAttr`, `LegacyAttr`).

### Agent run: `invoke_agent {agent name}`

| Attribute | Value |
| --- | --- |
| `gen_ai.operation.name` | `invoke_agent` |
| `gen_ai.agent.name` | The agent's `name` |
| `gen_ai.agent.id` | The agent's `id`, when set |
| `gen_ai.provider.name` | The provider's `name` |
| `gen_ai.conversation.id` | `sessionId`, when set |
| `lousho.cost_usd` | Cumulative estimated USD of the run (every model call and delegated child run); absent when any model used has no known price |
| `lousho.usage.estimated` | `true` when any of the run's tokens were estimated |

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
| `lousho.cost_usd` | Estimated USD of this step, when the built-in price table (or `registerModel`) knows the model; absent otherwise |
| `lousho.usage.estimated` | `true` when the provider reported no usage and the tokens were estimated |

### Tool call: `execute_tool {tool}`

| Attribute | Value |
| --- | --- |
| `gen_ai.operation.name` | `execute_tool` |
| `gen_ai.tool.name` | The tool name |
| `gen_ai.tool.call.id` | The model's tool-call id (agent runs) |
| `gen_ai.tool.description` | The tool's description, when it has one |
| `gen_ai.tool.type` | `function` |
| `gen_ai.agent.name`, `gen_ai.conversation.id` | The calling agent / session |
| `lousho.tool.parent_call_id` | On a call a [code mode](./code-mode.md) script made: the `run_code` call's id (its span is the parent) |

### Flows

The GenAI spec defines no convention for flow nodes, so node spans use the
`lousho.flow.*` namespace. The run span uses the spec's workflow convention.

| Span | Attribute | Value |
| --- | --- | --- |
| `invoke_workflow {name}` | `gen_ai.operation.name` | `invoke_workflow` |
| | `gen_ai.workflow.name` | The flow's `name` |
| | `lousho.flow.code` | The flow's `code` |
| | `lousho.flow.outcome` | `success` or `error` |
| `flow.node {type}` | `lousho.flow.node.id` | The node's id |
| | `lousho.flow.node.type` | The node type (`sequence`, `llmCall`, ...) |
| | `lousho.flow.outcome` | `success` or `error` |

### Errors

A failed span gets `error.type` and an error span status (OpenTelemetry
`ERROR`, message = the error message). `error.type` is the thrown error's
`name` (`_OTHER` when a non-`Error` is thrown). A tool call that returns an
error to the model (`isError`) is marked `error.type = tool_error`.

## Metrics

`createOtelTraceExporter()` also records the OpenTelemetry GenAI client
metrics through `@opentelemetry/api`'s metrics API, using the global
`MeterProvider` (`metrics.getMeter(...)`), or the `meter` option:

| Metric | Type, unit | Recorded | Attributes |
| --- | --- | --- | --- |
| `gen_ai.client.token.usage` | Histogram, `{token}` | Once per token type for every model call that reports (or estimates) usage | `gen_ai.operation.name` (`chat`), `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model` (when known), `gen_ai.token.type` (`input` or `output`) |
| `gen_ai.client.operation.duration` | Histogram, `s` | Every model call (`chat`) and tool call (`execute_tool`) | `gen_ai.operation.name`, `gen_ai.provider.name` and `gen_ai.request.model` (model calls), `gen_ai.response.model` (when known), `error.type` (when it failed) |

Both use the spec's recommended bucket boundaries. They follow the
`gen-ai-metrics` page of semantic-conventions v1.40 (`Development` stability):
the newest conventions split the token histogram into per-type counters,
which this SDK does not emit yet. Agent and flow spans are not counted in the
duration metric, only the model and tool calls inside them.

```ts
import { metrics } from '@opentelemetry/api';
import { ConsoleMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { createOtelTraceExporter } from '@lousho/build-ai-agent/otel';

// Swap ConsoleMetricExporter for an OTLP exporter to reach any backend.
metrics.setGlobalMeterProvider(
  new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter: new ConsoleMetricExporter() })] })
);

const exporter = createOtelTraceExporter(); // metrics on by default
// createOtelTraceExporter({ metrics: false })  // spans only
// createOtelTraceExporter({ meter })           // an already-obtained Meter
```

Without a registered `MeterProvider`, OpenTelemetry's no-op meter discards
the records. The metrics API lives in `@opentelemetry/api`, so nothing is
recorded (and nothing is loaded) when that optional peer is not installed.
The cost is an estimate from the price table (see `registerModel`), not a bill.

## Message and argument content is opt-in

Prompts, model output and tool arguments/results are sensitive and large, so
the `gen_ai.*` content attributes are **never recorded by default**. Opt in
per agent with `createAgent({ exporter, captureContent: true })`.

#### Advanced: the executor API

With the executor, opt in per run:

```ts
import { AgentExecutor, type TraceExporter } from '@lousho/build-ai-agent';

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

## Local traces

`fileTraceExporter()` from `@lousho/build-ai-agent/traces` writes each run to a
file, and `lousho traces` shows the files in the terminal. No OpenTelemetry
backend, no extra package.

```ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { fileTraceExporter } from '@lousho/build-ai-agent/traces';
import { z } from 'zod';

const getWeather = defineTool({
  name: 'get_weather',
  description: 'Current weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => `Sunny in ${city}`,
});

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  tools: [getWeather],
  exporter: fileTraceExporter({ dir: '.lousho/traces' }), // the default dir
});
```

Then, from the project directory:

```bash
npx lousho traces                 # the 20 most recent runs, newest first
npx lousho traces --limit 50 --json
npx lousho traces 3f2a            # one run as a tree; a unique id prefix is enough
npx lousho traces 3f2a --content  # also the captured messages and tool arguments
```

```
TIME    AGENT    DURATION  MODEL  TOOLS  TOKENS IN/OUT  COST       STATUS  ID
2h ago  weather  1.65s     2      1      159/32         $0.000043  ok      3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f

Trace 3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f  4 spans, 1.65s
invoke_agent weather         |████████████████████████|     1.65s  $0.000043
├─ chat gpt-4o-mini          |█████████████           |     900ms  openai/gpt-4o-mini  in 62 out 18  $0.000020
├─ execute_tool get_weather  |             █          |      22ms  tool get_weather
└─ chat gpt-4o-mini          |             ██████████ |     705ms  openai/gpt-4o-mini  in 97 out 14  $0.000023
```

Options: `--dir D` reads another directory (default `.lousho/traces`),
`--limit N` lists N runs (default 20), `--json` prints the summaries or the
spans as JSON. An id prefix that matches several runs lists them and exits 1.
Colour is off when `NO_COLOR` is set or the output is not a terminal. The
token counts are the run's `chat` spans, sub-agents' included; the cost is the
run's rolled-up `lousho.cost_usd`, blank (`-`) when a model's price is unknown.

**Files.** One file per run at `<dir>/<YYYY-MM-DD>/<traceId>.jsonl` (the run's
local start date; the trace id is the id of its `invoke_agent` span), so old
traces can be deleted by day. Each line is one finished span, written as it
ends:

```json
{"v":1,"traceId":"3f2a…","id":"a100…","parentId":"3f2a…","name":"chat gpt-4o-mini","kind":"client","startTime":1790848800005,"endTime":1790848800905,"attributes":{"gen_ai.usage.input_tokens":62,"…":"…"}}
```

`startTime` and `endTime` are milliseconds since the epoch; `attributes` are
the span attributes above, unshortened. A span that never ended (the process
died) is not in the file. If the directory cannot be written, the exporter
warns once and the run goes on. `listTraces({ dir, limit })` and
`readTrace(idOrPrefix, { dir })` read the files from code.

The files hold what the spans hold: the deprecated `input`, `prompt`, `args`
and `result` attributes carry message and tool content (see
[Deprecated attribute names](#deprecated-attribute-names)), and
`captureContent: true` adds the `gen_ai.*` content. Keep `.lousho/` out of
version control; projects made by `lousho init` ignore it.

`lousho dev` and `lousho chat` write these files when you pass `--traces`
(into `.lousho/traces`) or `--traces=<dir>`, for a spec file, an agent
directory or a module, so a spec-file agent needs no code to be traced. It is
opt-in on purpose: the files persist prompt and tool content, and
`captureContent: false` does not remove it (only `redactContent: true` does),
so nothing is written to disk unless you ask. The spec file format has no
traces setting.

## Backends

Any backend that ingests OpenTelemetry traces (OTLP) receives these spans.
Backends and tools that understand the GenAI semantic conventions can render
them as LLM, agent and tool calls with token usage; others show them as
ordinary spans with attributes. Which conventions a given backend supports,
and which version of them, varies; check its documentation.
