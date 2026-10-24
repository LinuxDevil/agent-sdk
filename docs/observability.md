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

Any object with `onSpanStart` and `onSpanEnd` is an exporter. The run does not
wait for them: a hook that throws, or an `async` one whose promise rejects, is
reported once per exporter with `console.warn` and otherwise ignored.

#### Advanced: the executor API

With the executor, pass the exporter to `AgentExecutor.execute()`:

```ts
import { AgentExecutor } from '@lousho/build-ai-agent/executor';
import { type TraceExporter } from '@lousho/build-ai-agent';

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

Each `send()` / `stream()` call is a trace of its own unless you parent it.
To put several runs in one trace, pass a span id of yours as `parentSpanId`;
the run's `invoke_agent` span becomes its child, and its cost rolls up into it:

```ts
import { withSpan, type SimpleAgent, type TraceExporter } from '@lousho/build-ai-agent';

declare const exporter: TraceExporter;
declare const planner: SimpleAgent;
declare const writer: SimpleAgent;

await withSpan(exporter, 'research pipeline', {}, async (span) => {
  await planner.send('Plan the report.', { parentSpanId: span.id });
  await writer.send('Write it.', { parentSpanId: span.id });
});
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
| `gen_ai.agent.name` | The agent's `name`. An unnamed sub-agent uses the key the lead knows it by (`subagents: { researcher }` gives `researcher`), and the span is named after it |
| `gen_ai.agent.id` | The agent's `id`, when set |
| `gen_ai.provider.name` | The provider's `name` |
| `gen_ai.request.model` | The agent's model (`settings.model`, else the provider's default), when known |
| `gen_ai.conversation.id` | `sessionId`, when set |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | The run's total tokens: every model call, including those of delegated child runs; absent when no call reported usage. These repeat the `chat` spans' tokens: see [Summing token usage over spans](#summing-token-usage-over-spans). The `gen_ai.client.token.usage` metric still counts each model call once |
| `lousho.cost_usd` | Cumulative estimated USD of the run (every model call and delegated child run, including a background child that finishes before the run ends); absent when any model used has no known price |
| `lousho.usage.estimated` | `true` when any of the run's tokens were estimated |
| `lousho.subagent.name` | On a sub-agent's run: the name the lead knows it by (the `task` tool's `agent`) |
| `lousho.subagent.depth` | On a sub-agent's run: `1` for a sub-agent of the top-level run, `2` for its sub-agent, and so on |
| `lousho.task.id` | On a sub-agent's run started by `task`: the task's `taskId` |

#### Summing token usage over spans

The totals on `invoke_agent` spans count tokens that the run's `chat` spans
already carry, and a lead run's total also counts its sub-agents' runs. A
backend that adds up `gen_ai.usage.*` over every span of a trace (some
OpenTelemetry LLM cost dashboards do) therefore counts each token at least
twice, and once more per level of sub-agent nesting: a lead with one sub-agent
whose model calls used 33 + 7 input tokens shows 40 on the `chat` spans, 7 on
the sub-agent's `invoke_agent` span and 40 on the lead's, 87 in all.

To get the true total, sum `chat` spans only (`gen_ai.operation.name = chat`),
read the top-level `invoke_agent` span alone, or use the
`gen_ai.client.token.usage` metric. If the backend cannot filter, pass
`createOtelTraceExporter({ agentUsageTotals: false })`: the usage attributes
then stay on `chat` spans only (`lousho.cost_usd` stays on every span).

### Model call: `chat {model}` (CLIENT)

| Attribute | Value |
| --- | --- |
| `gen_ai.operation.name` | `chat` |
| `gen_ai.provider.name` | The provider's `name` |
| `gen_ai.request.model` | The requested model |
| `gen_ai.request.temperature`, `gen_ai.request.max_tokens` | When set |
| `gen_ai.response.model` | When the provider reports it |
| `gen_ai.response.id` | The provider's response id, when it reports one |
| `gen_ai.response.finish_reasons` | e.g. `["stop"]`, `["tool_call"]` |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | Token usage |
| `lousho.cost_usd` | Estimated USD of this step, when the built-in price table (or `registerModel`) knows the model; absent otherwise |
| `lousho.usage.estimated` | `true` when the provider reported no usage and the tokens were estimated |
| `lousho.retry.count` | How many times `withRetry()` (the agent's `retry`) retried this call; absent when it was not retried |
| `lousho.retry.errors` | Each retried failure's error category and HTTP status, e.g. `["timeout", "unknown 500"]` |

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

The exception is a local collector: when `LOUSHO_OBSERVE` points at loopback
(`1`/`true`, or a URL whose host is `127.0.0.1`, `localhost` or `::1`;
a `localhost` port that an SSH tunnel forwards to a remote daemon counts as
loopback too, so set `captureContent: false` if that daemon must not get content),
`createAgent` defaults `captureContent` to `true`, so the daemon's trace view
shows the prompt, the model output and the tool arguments and results that
explain a failure. Only the daemon gets that content, and it stays in the
daemon's db on your machine: the agent's own `exporter` (`fileTraceExporter()`
files, an OTLP or vendor exporter, the built server's OTel export) still sees
every span without it, unless the agent sets `captureContent: true` or the
OTel content variable below is `true`. Turn it off with `captureContent: false`;
a collector beyond loopback keeps the opt-in default. The default applies to
agents built with `createAgent`.

`redactContent` keeps only the legacy `input`/`prompt`/`args`/`result`
attributes off; it does not scrub `gen_ai.*` message content. On a loopback
collector the message text, including any secret typed into a prompt, is
stored in the local db, so set `captureContent: false` if that is not wanted.

#### Advanced: the executor API

With the executor, opt in per run:

```ts
import { AgentExecutor } from '@lousho/build-ai-agent/executor';
import { type TraceExporter } from '@lousho/build-ai-agent';

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
| `error` (the error message; absent on success) | `error.type` and the span status |
| `input`, `prompt`, `args`, `result` | `gen_ai.input.messages`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` (opt-in, see above) |

With `createOtelTraceExporter({ legacyAttributes: false })` the OpenTelemetry
spans carry only the GenAI names, not the deprecated ones next to them (fewer
attributes per span); the default `true` keeps both.

The deprecated content attributes (`input`, `prompt`, `args`, `result`) are
off by default: `redactContent` defaults to `true`. Pass `redactContent: false`
to record them as before; `captureContent` governs only the `gen_ai.*` content
attributes.

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
TIME    AGENT    DURATION  MODEL CALLS  TOOL CALLS  TOKENS IN/OUT  COST       STATUS  ID
2h ago  weather  1.65s     2            1           159/32         $0.000043  ok      3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f

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
token counts and the cost are the sums of the run's `chat` spans, sub-agents'
included (background ones too); the cost is blank (`-`) when a model's price is
unknown.

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

The files hold what the spans hold. By default that is no message or tool
content: the deprecated `input`, `prompt`, `args` and `result` attributes are
recorded only with `redactContent: false` (see
[Deprecated attribute names](#deprecated-attribute-names)), and
`captureContent: true` adds the `gen_ai.*` content. Keep `.lousho/` out of
version control; projects made by `lousho init` ignore it.

`lousho dev` and `lousho chat` write these files when you pass `--traces`
(into `.lousho/traces`) or `--traces=<dir>`, for a spec file, an agent
directory or a module, so a spec-file agent needs no code to be traced. It is
opt-in on purpose: the files persist span timings, token counts and costs,
and prompt and tool content only if the agent sets `redactContent: false` or
`captureContent: true`, so nothing is written to disk unless you ask. The spec file format has no
traces setting.

## The observe daemon

`lousho observe start` runs a local collector on `http://127.0.0.1:7777`
(loopback only, no auth needed). When `LOUSHO_OBSERVE` is set, every agent
built on this SDK reports spans to it automatically — `1`, `true`, `on` or `yes`
emits to the default URL, an `http://`/`https://` URL emits there, and
`0`, `false`, `off`, `no`, `none`, `disabled` or empty (any case) turn reporting
off. Any other value is treated as a typo: one warning naming `LOUSHO_OBSERVE`
is printed per process and reporting stays off. `LOUSHO_OBSERVE_PROJECT` labels
the rows; `LOUSHO_OBSERVE_TOKEN` sends a bearer token for daemons bound
beyond loopback (`--require-token` plus `lousho observe token create`).

One SQLite file (default `~/.lousho/observe.db`, WAL mode) holds the fleet's
observations, sessions, eval scores, prompt versions and shared context.
`npx lousho studio` renders it in the Observe tabs: trace trees with latency
waterfalls, per-agent insights (runs/day, p50/p95 latency, cost, error
rate), a live fleet monitor (heartbeat-derived status — a crashed agent's
open sessions flip to `interrupted`), and eval score history. Alerts on
`down` transitions or error-rate thresholds POST to `--webhook` URLs or an
`alerts.json` next to the db.

Insights averages runs/day over the days an agent was active in the window
(from the later of the window start and the agent's first sighting), so an
agent first seen today with 12 runs reports 12/day, not 12/7. The per-bucket
series (`GET /api/v1/insights` `series`, hour or day buckets per agent) carries
`runs`, `errors`, `cost_usd`, `input_tokens`, `output_tokens`,
`latency_ms`, plus `p95_latency_ms` (over the bucket's finished runs; no row
when none finished) and `error_rate` (errors / runs). Those two are stored per
bucket, not summed. A db written by an older daemon lacks them for past
buckets: run `lousho observe rebuild-rollups` once to backfill.

The daemon also serves two stores agents can use at runtime:

- **Prompt registry.** `createAgent({ prompt: 'name@version' })` (or
  `'name@label'`) or `LOUSHO_PROMPT` fetches instructions from it at build
  (`@latest` and labels resolve on the daemon; an unreachable daemon falls back to `instructions`; with no
  `instructions`, the run fails with `LOUSHO_PROMPT_UNRESOLVED`). A failed
  fetch is not cached for good: runs in the next 30 seconds resolve at once
  (using `instructions`, or failing), then the next run retries it, so a
  daemon that was briefly down at build recovers without a restart. That one
  run waits for the retry fetch, up to 2.5 seconds. Every run logs the exact version
  used. `lousho prompt push` publishes a new
  version; a push whose text and variables equal the latest version's mints
  nothing (`200 { unchanged: true, version }`). A label (`prod`, `staging`)
  points at exactly one version: `lousho prompt label mira prod 3` (or `PUT
  /api/v1/prompts/:name/labels/:label` with `{ version }`) moves it, `push
  --labels` moves it onto the pushed version, and `GET
  /api/v1/prompts/:name/:ref` takes an integer, `latest` or a label. A
  label ref takes the same path as a version: unresolvable means the
  `instructions` fallback or `LOUSHO_PROMPT_UNRESOLVED`, with the same
  30-second retry window.
- **Context hub.** `hub()` / `hubTools()` let agents publish and query
  namespaced key-values scoped `private` (the writing agent only) or
  `fleet` (every agent on the daemon).

Reporting is fire-and-forget and never blocks a run: when the daemon is
down, the failed batch is requeued and retried with exponential backoff (1 s,
2 s, 4 s ... capped at 30 s), so a daemon restart mid-run loses nothing. A
backlog drains in batches one right after another, each at most 1000 events
and 4 MB of JSON (under the daemon's per-request caps of 1000 events and
5 MB). Only these are dropped and counted in the reporter's `dropped`:
events evicted past the buffer cap (`maxBuffered`, default 5000 events, or
32 MB of serialized events, whichever comes first; oldest first); events
past the newest 16 MB when a crash flushes; events still unsent after the exit flush's final attempt; a single
event too large for any request (over 5 MB serialized, for example with
content capture on); and a batch the daemon refuses outright (`400`/`413`),
which is never retried.
The count rides on every heartbeat as `meta.dropped` (cumulative for the process),
and each row of the daemon's `/api/v1/agents` fleet list exposes the latest one as
`dropped`: a number, or `null` for an agent on an older SDK that sent none.

A process that dies of an uncaught exception or an unhandled rejection still
reports its last run: the reporter watches `uncaughtExceptionMonitor` and
sends what it holds (the newest 16 MB of it), oldest first, holding up the
crash for up to 1 s per reporter. Node's error output and exit code stay as they were, and a script
that survives the throw (its own `uncaughtException` handler, or a capture
callback such as the REPL's) keeps reporting. An explicit `process.exit()` or
a SIGKILL still loses what is buffered.

Every run is visible from the moment it starts: the reporter sends a run's
root span (the top `invoke_agent`, the one with no parent) as soon as it
opens, without waiting for the 5 s interval, and Studio lists that trace as
`running`. The run's end replaces that row with the final status, usage,
cost and output, and counts once. So a process killed mid-run (SIGKILL,
power loss) still leaves its trace behind, and the trace flips to
`interrupted` when the agent stops heartbeating and the sweep marks it
`down`. Each reporter process also sends a random `instance_id`, because a
restart or a second process of the same agent reports under the same agent
id. Processes of one agent running side by side never interrupt each
other's runs while they keep heartbeating, even when they share a hostname
and pid (`--network host` replicas are all pid 1). When a process of an
agent goes quiet while another process of it keeps heartbeating (a supervisor restarted it under a new pid, or one of
several workers died), the sweep marks the quiet process's open runs
`interrupted` once it has missed about two heartbeats (the `stale` mark),
judged on that process's own heartbeat interval and on the daemon's clock. A
restart on the same host with the same pid (a container's pid 1) marks them
sooner: at the first heartbeat of the new process (after its first) that
comes more than one heartbeat interval plus 10 seconds after the old
process's last, if the old process has been silent since the new one
appeared. With no process of the agent left, the
agent goes `down` and its open runs are marked as above. A process that exits gracefully mid-run
(SIGINT, SIGTERM) marks its own open runs `interrupted` right away. An agent
with heartbeats turned off (`heartbeatIntervalMs: 0`) is never swept, so its
killed runs stay `running`. Child spans (model calls and tool calls)
are still sent only when they finish, so a killed run keeps the root and
any child that finished and was already sent.

Eval scores flow through the same pipe —
`lousho eval --observe` emits them even when `LOUSHO_OBSERVE` is unset.
Each case yields one `<eval>/<check>` row per assertion plus one `<eval>` pass/fail row (1 when every gate check passed, else 0).

Human feedback is a score too. `POST /api/v1/scores` with
`{ "trace_id", "obs_id"?, "name", "value", "comment"? }` (`value` a number or
`null`, `name` up to 200 characters, `comment` up to 10 000) adds one score with
`source: "human"` and answers `201 { "score_id" }`. Each call adds a row, and
the score is attributed to the trace's agent. An unknown `trace_id` (or an
`obs_id` that is not in that trace) is a `404`, an empty `name` a `400`. It
takes the same token as ingest, and `GET /api/v1/scores?trace_id=...` lists it.

### Retention

The daemon keeps 30 days of runs by default. On its first sweep after start,
and then once a day, it deletes every trace whose observations have all
finished and whose last one ended more than `--retention-days` ago (default
30; `--retention-days 0` keeps everything). A whole trace goes or stays: one
still-open observation (`end` unset, a run in progress) keeps the entire trace,
however old. With a trace go its scores and its prompt-use links; scores older
than the window whose trace has no observations left go too. A session is
deleted only when it is not `active`, ended (or, with no end, started) before
the window, and no remaining observation references it, so an old thread
that is still active is never pruned.

Pruning never touches the Insights rollups (charts for pruned days stay),
the prompt registry, hub entries, the agent registry or tokens. The daily
prune does not `VACUUM`, which would stall ingest; to reclaim disk space, run
`lousho observe prune --older-than 30d`. It prunes now with the window you
give (whole days only), prints how many observations, scores and sessions it
deleted, then runs `VACUUM`. It is safe while the daemon is running on the
same db.

### Trace list API

`GET /api/v1/traces` returns `{ traces, total, limit, offset }`, one row per
trace, newest first. Query parameters (all optional):

| Parameter | Meaning |
| --- | --- |
| `agent_id`, `session_id`, `project`, `status` | Exact match (`status` is the root observation's, or `running` / `interrupted`). |
| `from`, `to` | Trace start window in ms epoch, half-open: `from <= start < to`. |
| `since`, `until` | Older inclusive bounds on each observation's start, kept for existing callers. |
| `q` | Case-insensitive (ASCII) substring of the root observation's name, input or output. `%` and `_` match literally. |
| `min_duration_ms` | Traces at least this long (`end - start`). |
| `model` | Traces where any observation used this model. |
| `sort` | `start` (default), `duration`, `tokens` (input + output) or `cost`. Ties break on `trace_id`. |
| `order` | `desc` (default) or `asc`. |
| `limit`, `offset` | Page size (1-500, default 50) and offset. |

An unknown `sort` or `order`, or a non-numeric `min_duration_ms`, answers
`400` with code `LOUSHO_REQUEST_INVALID`.

Each row has `trace_id`, `name`, `agent_id`, `session_id`, `start`, `end`,
`status`, the counts `observations`, `generations`, `tools` and `errors`, the
sums `input_tokens`, `output_tokens` and `cost_usd`, and:

- `agent_name`: the agent's name from its heartbeat, or `null`.
- `model`: the first model call's model, or `null`.
- `error_message`: the first failed observation's `error` attribute (for
  example `upstream 529 overloaded`), or `null`.
- `input_preview` / `output_preview`: the first 200 characters of the run's
  stored input and output, or `null` when none was captured.

### Sessions (threads) API

`GET /api/v1/sessions` returns `{ sessions, total, limit, offset }`, newest
first (`started_at` descending). Query parameters (all optional): `agent_id`,
`status` (exact match), `from` / `to` (session start in ms epoch, half-open
`from <= started_at < to`), and `limit` / `offset` (1-500, default 50). Each
session row is `{ session_id, agent_id, agent_name, status, started_at,
ended_at, traces, input_tokens, output_tokens, cost_usd, last_input_preview }`:
`traces` counts distinct trace ids, tokens and cost sum the session's
observations, and `last_input_preview` is the first 200 characters of the root
input of its latest trace.

`GET /api/v1/sessions/:id` returns `{ session, traces }` with the traces
(same rows as the trace list) ordered by start ascending, capped at 500; an
unknown id is a 404 with code `LOUSHO_REQUEST_INVALID`.

## The built server

The server `lousho build --target=node-server` or `--target=docker` generates
exports traces with no code when the standard `OTEL_EXPORTER_OTLP_ENDPOINT`
(or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) variable is set where it runs. It
registers an OpenTelemetry tracer provider that sends spans over OTLP/HTTP,
and gives the agent `createOtelTraceExporter()`, so every `/chat` turn arrives
as the `invoke_agent` / `chat` / `execute_tool` tree above. An `exporter` the
agent's config already has (an agent directory's or a module's) keeps
running: both receive every span.

The OpenTelemetry SDK is not bundled. Install these packages next to
`dist/server.js`, or add them to the build's `package.json` dependencies
before you build the docker image:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-trace-node@^2 @opentelemetry/resources@^2 @opentelemetry/exporter-trace-otlp-http
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_SERVICE_NAME=support-agent node dist/server.js
```

- The server imports them at start-up only when the variable is set. When one
  is missing it logs which packages to install and serves without exporting
  traces.
- `service.name` is `OTEL_SERVICE_NAME` when set, otherwise the agent's name.
  `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_EXPORTER_OTLP_HEADERS` (for an API key)
  and the batch settings (`OTEL_BSP_SCHEDULE_DELAY`, ...) work as the OTel SDK
  documents them.
- On SIGINT or SIGTERM the server sends the spans it still holds before it
  exits.
- With neither variable set, nothing is imported and the server runs as before.

Message content follows the agent's own settings
([Message and argument content is opt-in](#message-and-argument-content-is-opt-in)).

## Backends

Any backend that ingests OpenTelemetry traces (OTLP) receives these spans.
Backends and tools that understand the GenAI semantic conventions can render
them as LLM, agent and tool calls with token usage; others show them as
ordinary spans with attributes. Which conventions a given backend supports,
and which version of them, varies; check its documentation.
