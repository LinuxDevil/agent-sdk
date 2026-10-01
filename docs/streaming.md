# Streaming

`agent.stream()` runs an agent exactly like `agent.send()` and reports the run
as a stream of typed events: model text as it arrives, every tool call,
step boundaries, approval requests, and a final `run.done`. Every event is a
plain JSON object, so you can forward it to a browser over Server-Sent Events
or a WebSocket without converting it.

```ts
import { createAgent } from '@loushy/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });

for await (const event of agent.stream('Weather in Paris?')) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
```

The full API has the same method: `AgentExecutor.stream(options)` takes the
same options as `AgentExecutor.execute()` (approval store, checkpoints, hooks,
tracing, `toolConcurrency`, ...).

## The `AgentRun` handle

`stream()` returns an `AgentRun`:

```ts no-verify
interface AgentRun extends AsyncIterable<AgentEvent> {
  readonly runId: string;                   // the runId on every event
  readonly result: Promise<ExecutionResult>; // what send() / execute() would return
  enqueue(input: AgentInput): EnqueueResult; // add user input to the running run
}
```

- **The run starts immediately.** You do not have to iterate: `await run.result`
  on its own drives the run to completion.
- **`result`** resolves with the same `ExecutionResult` that `send()` returns,
  and rejects with the same error `send()` would reject with. An aborted run
  resolves with `finishReason: 'aborted'`; a run paused for approval resolves
  with `finishReason: 'awaiting-approval'` and `approvalId`. Leaving `result`
  unawaited never causes an unhandled rejection.
- **Breaking out of the `for await` loop early aborts the run** (through the
  same path as `signal`, see [Cancellation](#cancellation)). `result` then
  resolves with `finishReason: 'aborted'`.
- **No backpressure; nothing is dropped.** The run never waits for the
  consumer. Events are buffered until you read them, so a slow consumer sees
  every event, in order. Iterating after the run finished still yields all of
  its events.
- **`enqueue(input)`** adds user input to the run while it runs: it joins the
  transcript before the next model call. See [Queued input](#queued-input).
- **One consumer.** An `AgentRun` can be iterated once; a second `for await`
  throws. To fan out, collect the events yourself.
- Invalid options (no `provider`, `agent` or `input`, a bad `toolConcurrency`)
  throw synchronously from `stream()`.

```ts
import { createAgent } from '@loushy/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });

const run = agent.stream('Summarize the report', { signal: AbortSignal.timeout(30_000) });
const result = await run.result; // no iteration needed
console.log(result.finishReason, result.text);
```

## Streaming a session turn

`session.stream(input, { signal })` streams one turn of a multi-turn
[session](./sessions.md) and returns the same `AgentRun`. The run sees the
conversation so far, and when it ends its turn is saved to the session's
store, just as `session.send()` saves it. `run.done` is delivered after the
save, so the transcript is complete when the loop ends. An aborted or failed
run, or one you stop reading early, is not saved.

```ts
import { createAgent } from '@loushy/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });
const session = agent.session({ id: 'user-42' });

for await (const event of session.stream('My name is Ali.')) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
const again = session.stream('What is my name?'); // streams with the first turn in its history
console.log((await again.result).text);
```

## Event schema (version 1)

Every event has these fields:

| Field       | Type     | Meaning |
| ----------- | -------- | ------- |
| `type`      | string   | The event type (table below). Narrow on it in TypeScript. |
| `runId`     | string   | Identifies the run. The same on every event of one `stream()` call. |
| `seq`       | number   | `0` for the first event, then `+1` per event, with no gaps. |
| `timestamp` | string   | When the event was emitted, ISO 8601 (`2026-10-01T09:30:00.000Z`). |
| `v`         | `1`      | Schema version, exported as `AGENT_EVENT_SCHEMA_VERSION`. |
| `subagent`  | object, optional | Only on events of a sub-agent's run - see [Sub-agents](#sub-agents). |

The event types and their extra fields:

| `type`               | Extra fields | Emitted |
| -------------------- | ------------ | ------- |
| `run.start`          | `agentName: string`, `agentId?: string` | First event of every run. |
| `step.start`         | `step: number` | A model step begins: one model call plus the tool calls it asks for. `step` counts from 1 (a run resumed from a checkpoint continues the count). |
| `text.delta`         | `text: string` | A chunk of model text, as it arrives. |
| `text.done`          | `text: string` | The step's complete text: the concatenation of its `text.delta` events. Only for steps with text. |
| `tool.start`         | `toolCallId: string`, `toolName: string`, `args: Record<string, unknown>` | A tool call starts. `args` are the model's arguments parsed from JSON (`{}` when they are not valid JSON). |
| `tool.done`          | `toolCallId`, `toolName`, `result: unknown`, `durationMs: number` | A tool call returned. `result` is the value as it would be JSON-encoded (`undefined` becomes `null`, a `Date` becomes a string). `durationMs` counts from its `tool.start`. |
| `tool.error`         | `toolCallId`, `toolName`, `error: { name: string, message: string }`, `durationMs: number` | A tool call failed: it threw, its arguments did not match its schema (`name: 'ToolArgumentsValidationError'`), or the tool does not exist. The model gets the error as the call's result and the run continues. |
| `approval.requested` | `approvalId: string`, `toolCallId`, `toolName`, `args: Record<string, unknown>`, `kind?: 'question'`, `question?: { text, options?, allowFreeText? }` | A tool call needs a human decision. The run then stops; resume it with `agent.approvals.resolve()` or `resumeAfterApproval()` (see [Approvals](./approvals.md)). An `ask_question` call carries `kind: 'question'` and its `question`; answer it with `agent.approvals.answer()` (see [Asking the user a question](./approvals.md#asking-the-user-a-question)). |
| `permission.decision` | `toolCallId`, `toolName`, `decision: 'allow' \| 'deny' \| 'ask' \| 'default'`, `rule?: { index: number, reason?: string }`, `args?: Record<string, unknown>`, `at: string` | How a tool call's [permission rules](./approvals.md#permission-policies) decided it: after its `tool.start`, before the call's own `tool.done` / `tool.error` / `approval.requested`. Only when the run sets `permissions` or `onPermissionDecision`; `args` is left out under `redactContent`. |
| `step.done`          | `step: number`, `finishReason: string`, `usage?: { promptTokens, completionTokens, totalTokens }` | A step ends. `finishReason` is the model's (`'stop'`, `'tool_calls'`, `'length'`, ...), or `'awaiting-approval'`, `'aborted'` or `'error'` when the step ended that way (a run that runs out of `maxSteps` still wanting to continue ends with `run.done` `'max-steps'`). `usage` is this step's model call, absent when the call produced no response. |
| `error`              | `error: { name: string, message: string }` | An error. If it ends the run, `run.done` with `finishReason: 'error'` follows. A provider error retried under `surfaceRetryableProviderErrors` is followed by further steps instead. |
| `provider.retry`     | `attempt: number`, `maxRetries: number`, `delayMs: number`, `error: { message: string, category?: string }`, `provider: string` | A model call failed and is retried after `delayMs` (`createAgent({ retry })` or any `withRetry()` provider). `attempt` is the attempt that failed (1 = first); `category` is `'rate-limit'`, `'timeout'`, ... and absent when unknown (a 5xx, for example). |
| `provider.fallback`  | `from: string`, `to: string`, `error: { message: string }` | A model call still failed after its retries and the next provider takes over (`createAgent({ fallbackModels })` or any `withFallback()` provider). `from` and `to` are provider names. |
| `compaction.start`   | `strategy: string`, `tokensBefore: number`, `contextWindow: number`, `thresholdTokens: number` | The compaction hook (`createAgent({ compaction })`) found the next model request above its threshold and starts compacting it. Exactly one `compaction.done` follows. See [Context compaction](./compaction.md). |
| `compaction.done`    | `strategy: string`, `tokensBefore: number`, `tokensAfter: number`, `prunedToolCallIds: string[]`, `summary?: boolean`, `error?: { message: string }` | A compaction ended. `tokensAfter` equals `tokensBefore` when nothing could be compacted; `summary` is set when old turns were replaced by a summary; `error` is set when the strategy failed or fell back (the run continues). |
| `budget.exceeded`    | `limit: string`, `value: number`, `max: number`, `scope: 'run' \| 'session'` | A [`limits` budget](./configuration.md#budgets) tripped: `limit` is `'maxTokens'`, `'maxInputTokens'`, `'maxOutputTokens'`, `'maxCostUsd'`, `'maxDurationMs'` or `'maxSteps'`, `value` what was spent, `max` the limit. `run.done` (`'budget-exceeded'`) follows; with `onExceeded: 'throw'`, `error` and `run.done` (`'error'`). |
| `input.queued`       | `id: string`, `text: string` | `run.enqueue()` took an input (`id` is `EnqueueResult.id`, `text` its user text). Can come at any point of the run, also inside a step. See [Queued input](#queued-input). |
| `input.applied`      | `id: string`, `step: number` | The queued input joined the transcript, right before the model call of `step`: the `step.start` of that step follows. |
| `guardrail.tripped`  | `name: string`, `kind: 'input' \| 'output' \| 'tool'`, `reason: string`, `toolName?: string` | An [input, output or tool guardrail](./guardrails.md#input-and-output-guardrails) blocked: before the first model call (input), before the step's `text.done` (output) or after the call's `tool.start` (tool). `run.done` (`'guardrail'`) follows; with `onTripped: 'throw'`, `error` and `run.done` (`'error'`). |
| `guardrail.rewrote`  | `name`, `kind`, `reason`, `toolName?` | A guardrail rewrote the input, the step's text (before its `text.done`, which carries the new text) or a tool call's arguments. The run continues. |
| `run.done`           | `finishReason: string`, `text: string`, `usage?: { promptTokens, completionTokens, totalTokens }`, `object?: unknown` | Last event of every run, exactly once, including aborted, failed and awaiting-approval runs. `finishReason` and `text` match `run.result` (`'max-steps'` when the `maxSteps` budget ran out while the model still wanted to continue); a failed run has `finishReason: 'error'`, `text: ''` and no `usage`. `object` is `run.result`'s validated `object` for an agent with an `output` schema (see [Structured output](./structured-output.md)), absent otherwise. |

Optional fields are left out when they have no value. They are never
`undefined`, so `JSON.parse(JSON.stringify(event))` returns an equal object.

### Ordering guarantees

- `run.start` is first and `run.done` is last, each exactly once.
- Each `step.start` is followed by exactly one `step.done` with the same
  `step`, before the next `step.start`. Everything a step does happens between
  the two.
- Inside a step: `compaction.start` / `compaction.done` (if the request was
  compacted, before the model call), `provider.retry` / `provider.fallback`
  events (if the model call fails), then `text.delta` events, then `text.done`, then the tool events.
- Tool calls of one step run in parallel (see `toolConcurrency`):
  `tool.start` events come in the model's call order and `tool.done` /
  `tool.error` events in completion order. Match them by `toolCallId`.
- `input.queued` comes when `run.enqueue()` is called (after `run.start`, even
  for input queued before the run got going), so it can fall inside a step.
  Its `input.applied` comes between the `step.done` of the step that was
  running and the next `step.start`, which carries the `step` it names.
- When a call needs approval, the calls before it run and report, then
  `approval.requested`, `step.done` (`'awaiting-approval'`) and `run.done`
  (`'awaiting-approval'`) follow. Calls after it never start.
- When a guardrail blocks, `guardrail.tripped` comes just before the end: for
  an input guardrail right after `run.start` (no step starts); for an output or
  tool guardrail inside the step, followed by `step.done` and `run.done`
  (`'guardrail'`). A blocked output has no `text.done`; calls after a blocked
  tool call never start.

A text-only run:

```
run.start → step.start → text.delta × n → text.done → step.done → run.done
```

A run with one tool call:

```
run.start
step.start(1) → tool.start → tool.done → step.done(1, 'tool_calls')
step.start(2) → text.delta × n → text.done → step.done(2, 'stop')
run.done('stop')
```

### TypeScript

`AgentEvent` is a discriminated union: narrowing on `event.type` gives the
payload. Each event type is exported too (`TextDeltaEvent`, `ToolDoneEvent`,
`RunDoneEvent`, ...), and `AgentEventOf<'tool.done'>` picks one by name.

```ts
import { isAgentEvent, isToolEvent, type AgentEvent } from '@loushy/build-ai-agent';

function render(event: AgentEvent): string {
  switch (event.type) {
    case 'text.delta':
      return event.text;
    case 'tool.start':
      return `\n[${event.toolName}] ${JSON.stringify(event.args)}\n`;
    case 'tool.error':
      return `\n[${event.toolName} failed: ${event.error.message}]\n`;
    case 'run.done':
      return `\n(${event.finishReason})\n`;
    default:
      return '';
  }
}

// isToolEvent / isTextEvent / isStepEvent narrow to an event family:
const toolNames = (events: AgentEvent[]) => events.filter(isToolEvent).map((e) => e.toolName);

// isAgentEvent validates an event received over the wire:
const received: unknown = JSON.parse('{"type":"run.start","runId":"r","seq":0,"timestamp":"","v":1,"agentName":"a"}');
if (isAgentEvent(received)) console.log(render(received), toolNames([received]));
```

### Versioning

`v` changes only when an existing event changes incompatibly (a field
removed, renamed or retyped). New event types and new optional fields can be
added without changing `v`, so ignore event types you do not know.

## Sub-agents

When the agent delegates with the `task` tool or a `createDelegateTool()`
tool (see [Sub-agents](./sub-agents.md)), the sub-agent's run is streamed
inside the same stream: its steps, `text.delta`s, `text.done`s, tool events
and errors appear between the lead's `tool.start` and `tool.done` (or
`tool.error`) for that call, each with a `subagent` field:

```json
{ "name": "researcher", "depth": 1, "toolCallId": "call_1", "description": "find sources" }
```

`toolCallId` is the lead's tool call that started the sub-agent; a sub-agent
of a sub-agent has `depth: 2` and the enclosing one as `parent`. Events
without `subagent` are the top-level run's: the ordering guarantees above hold
for them, and separately for each sub-agent's steps (several sub-agents
running in parallel interleave). `run.start` and `run.done` belong to the
top-level run only, so they still come exactly once. A sub-agent that pauses
for approval is reported once, by the top-level `approval.requested` (which
carries the sub-agent's call).

```ts
import { createAgent } from '@loushy/build-ai-agent';

const researcher = createAgent({ provider, instructions: 'You research.', description: 'Finds sources' });
const lead = createAgent({ provider, instructions: 'You coordinate.', subagents: { researcher } });

for await (const event of lead.stream('Write about bicycles')) {
  const who = event.subagent ? `[${event.subagent.name}] ` : '';
  if (event.type === 'text.delta') process.stdout.write(who + event.text);
}
```

## Token streaming and providers

When the provider implements `stream()` (all built-in providers and
`mockModel` do), each model step is streamed and `text.delta` events arrive
as the model produces text. Tool calls are assembled from the stream. When a
provider has no `stream()`, or its `supportsStreaming(model)` returns
`false`, the step falls back to `generate()` and its text arrives as a single
`text.delta` followed by `text.done`.

Streaming changes only how one model step is obtained. Hooks, argument
validation, approvals, parallel tool calls, checkpoints, cancellation,
tracing spans and the other `execute()` callbacks behave exactly as in
`send()`. `send()` and `execute()` themselves still use `generate()`.

A custom provider's `stream()` should yield `text-delta` chunks and a final
`finish` chunk with `finishReason` and `usage`. Tool calls can be yielded as
`tool-call` chunks, or resolved on the `toolCalls` promise of the
`StreamResult`. An `error` chunk fails the step.

## Cancellation

Pass `signal` to stop a run from outside, or break out of the loop. Both end
the run the same way as an aborted `send()`: the signal is checked between
stream chunks, before every model call and every tool call, and reaches the
provider and the tools. The stream ends with `step.done` (`'aborted'`, when a
step was running) and `run.done` (`'aborted'`), and `result` resolves with
`finishReason: 'aborted'`.

```ts
import { createAgent } from '@loushy/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });
const run = agent.stream('Write a long story');

let chars = 0;
for await (const event of run) {
  if (event.type === 'text.delta') chars += event.text.length;
  if (chars > 500) break; // aborts the run
}
console.log((await run.result).finishReason); // 'aborted'
```

## Queued input

`run.enqueue(input)` adds user input (a string, content parts or a
`Message[]`) to a run that is still going, for example a follow-up the user
types while the agent works. The run does not stop: the input joins the
transcript at the next safe point - after the current step's tool results,
never between a tool-call turn and its results - and the next model call sees
it, as if the user had typed it. Input queued while the model writes its final
reply gets one more step, so the model answers it in the same run.

```ts
import { createAgent } from '@loushy/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });
const run = agent.stream('Plan a weekend in Rome.');

const queued = run.enqueue('Keep it under 500 EUR.');
for await (const event of run) {
  if (event.type === 'input.applied') console.log(`applied before step ${event.step}`);
}
if (queued.applied === false || !(await queued.applied)) {
  // The run ended without it: send it as a new turn (e.g. session.send()).
}
```

`enqueue()` returns `{ id, applied }`. `id` is on the `input.queued` and
`input.applied` events. `applied` is `false` when the run had already
finished: the input was not taken, so send it yourself, as a new turn
(`session.send()`). Otherwise it is a promise that resolves to `true` once the
input is in the transcript, or to `false` when the run stopped before its next
model call (aborted, paused for approval, out of `maxSteps` or budget, or
failed); the input is then left to you too.

- Several inputs queued before the same model call are applied together, in
  the order they were queued.
- With checkpointing (`sessionId` or a durable session), an input that is
  still waiting is saved at the end of the run's checkpoint right away, the
  same slot as input queued behind unanswered tool calls (see
  [Durable execution](./durable-execution.md)). A crash, or a run that fails,
  does not lose it: `agent.resume()` applies it (`applied` of a run that
  failed in-process still resolves `false`). A run that finishes, pauses or is
  aborted does not keep it.
- Without a stream, pass an `InputQueue` as `ExecuteOptions.inputQueue` and
  call its `push()`: the same queue that is behind `run.enqueue()`. One
  queue serves one run.
- In a session, `agent.session({ turnPolicy: 'queue' })` makes a `send()` or
  `stream()` made while a turn runs (or waits to start) join that turn this way. See
  [Sessions](./sessions.md#the-session-object).

Queued input waits for the step that is running. Steering, which aborts the
in-flight model call and redirects the run at once, is planned as a follow-up
(LOU-V10).

```ts
import { AgentExecutor, InputQueue } from '@loushy/build-ai-agent';

const inputQueue = new InputQueue();
const pending = AgentExecutor.execute({ agent, provider, input: 'Plan my trip.', inputQueue });
inputQueue.push('Also book a hotel.');
const result = await pending;
```

## Example: terminal

```ts
import { createAgent, defineTool } from '@loushy/build-ai-agent';
import { z } from 'zod';

const getWeather = defineTool({
  name: 'get_weather',
  description: 'Current weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21 }),
});

const agent = createAgent({ model: 'openai/gpt-4o-mini', tools: [getWeather] });

for await (const event of agent.stream('Weather in Paris?')) {
  switch (event.type) {
    case 'text.delta':
      process.stdout.write(event.text);
      break;
    case 'tool.start':
      console.log(`\n→ ${event.toolName}(${JSON.stringify(event.args)})`);
      break;
    case 'tool.done':
      console.log(`← ${event.toolName} in ${event.durationMs}ms`);
      break;
    case 'run.done':
      console.log(`\n[${event.finishReason}, ${event.usage?.totalTokens ?? 0} tokens]`);
      break;
  }
}
```

## Example: Server-Sent Events

Events are JSON-serializable, so an SSE endpoint is one `res.write` per
event. Abort the run when the client disconnects.

```ts
import { createServer } from 'node:http';
import { createAgent } from '@loushy/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });

createServer(async (req, res) => {
  const question = new URL(req.url ?? '/', 'http://localhost').searchParams.get('q') ?? 'Hello!';
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for await (const event of agent.stream(question, { signal: controller.signal })) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}).listen(3000);
```

In the browser:

```ts no-verify
const source = new EventSource('/chat?q=Weather%20in%20Paris%3F');
source.onmessage = (message) => {
  const event = JSON.parse(message.data);
  if (event.type === 'text.delta') output.textContent += event.text;
  if (event.type === 'run.done') source.close();
};
```

For a React chat UI over this kind of endpoint, see [React](./react.md):
`useLoushyAgent()` POSTs the input and reads the same `data:` lines.

`loushy dev` serves this format for a session per browser tab: `POST /chat`
with `{ sessionId, input }` streams `agent.session({ id }).stream(input)` as
`data:` lines ending with `event: done`, and approvals are decided through
`POST /chat/:sessionId/approvals/:id` (see [CLI](./cli.md#loushy-dev)).

## Example: the full API

`AgentExecutor.stream()` accepts every `execute()` option. Here a tool that
needs approval ends the stream with `approval.requested`:

```ts
import { AgentExecutor } from '@loushy/build-ai-agent';

const run = AgentExecutor.stream({ agent, input, provider, toolRegistry, approvalStore });
for await (const event of run) {
  if (event.type === 'approval.requested') {
    console.log(`Approve ${event.toolName}(${JSON.stringify(event.args)})? id=${event.approvalId}`);
  }
}
const paused = await run.result; // paused.finishReason === 'awaiting-approval'
```
