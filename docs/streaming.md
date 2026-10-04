# Streaming

`agent.stream()` runs an agent exactly like `agent.send()` and reports the run
as a stream of typed events: model text as it arrives, every tool call,
step boundaries, approval requests, and a final `run.done`. Every event is a
plain JSON object, so you can forward it to a browser over Server-Sent Events
or a WebSocket without converting it. The `vendor/` model prefix chooses the
provider; with OpenRouter use `openrouter/<vendor>/<model>` (e.g.
`openrouter/openai/gpt-4o-mini`).

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });

for await (const event of agent.stream('Weather in Paris?')) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
```

The full API has the same method: `AgentExecutor.stream(options)` takes the
same options as `AgentExecutor.execute()` (approval store, checkpoints, hooks,
tracing, `toolConcurrency`, ...).

These events, the `AgentEvent` union, are the SDK's one event system: the
stream, the [listener options](#listening-without-iterating), `session.on()`,
the UI hooks, the server routes, ACP and channels all carry them.

## The `AgentRun` handle

`stream()` returns an `AgentRun`:

```ts no-verify
interface AgentRun extends AsyncIterable<AgentEvent> {
  readonly runId: string;                   // the runId on every event
  readonly result: Promise<ExecutionResult>; // what send() / execute() would return
  enqueue(input: AgentInput): EnqueueResult; // add user input to the running run
  steer(input: AgentInput): SteerResult;     // redirect the running run to new input
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
  transcript before the next model call. See [Queued input](./queue-and-steer.md#queued-input).
- **`steer(input)`** redirects the run: a model call that has not produced
  anything yet is aborted and made again with the input. See [Steering](./queue-and-steer.md#steering).
- **One consumer.** An `AgentRun` can be iterated once; a second `for await`
  throws. To fan out, collect the events yourself.
- Invalid options (no `provider`, `agent` or `input`, a bad `toolConcurrency`)
  throw synchronously from `stream()`.

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });

const run = agent.stream('Summarize the report', { signal: AbortSignal.timeout(30_000) });
const result = await run.result; // no iteration needed
console.log(result.finishReason, result.text);
```

## Listening without iterating

To observe every run without iterating one, give the agent a listener:
`createAgent({ onEvent })`, or `onAgentEvent` in the `AgentExecutor.execute()`
/ `stream()` / `resumeAfterApproval()` options. It is called synchronously
with each `AgentEvent` as it happens, on `send()` as on `stream()`, for
session turns and for runs resumed after an approval. It gets the same events,
in the same order, as iterating the stream would: with a listener, `send()` /
`execute()` stream each model call too, so a step's text arrives as several
`text.delta` events (one `text.delta` per step when the provider cannot
stream). Concatenate them, or use `text.done` for each step's whole text;
`AgentExecutor.execute({ streamModelCalls: false })` generates whole steps.
Output guardrails still check only the final reply of a `send()`, as without
a listener. Sub-agents' events arrive tagged with `subagent`.

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  onEvent: (event) => {
    if (event.type === 'tool.start') console.log('calling', event.toolName, event.args);
    if (event.type === 'run.done') console.log('done:', event.finishReason, event.usage?.totalTokens);
  },
});

await agent.send('Weather in Paris?');
```

### Migrating from `onEvent` / `ExecutionEvent`

`ExecuteOptions.onEvent` and its `ExecutionEvent` type were removed in this
release (they had been deprecated since LOU-D41). Pass `onAgentEvent` to
`AgentExecutor.execute()` / `stream()` / `resumeAfterApproval()` instead -
`createAgent({ onEvent })` already takes `AgentEvent`s and is unchanged.
The table below maps the old event names to the `AgentEvent`s a listener
gets now:

| `ExecutionEvent` (`onEvent`) | `AgentEvent` (`onAgentEvent`) |
| --- | --- |
| `start` (`agentId`, `agentName`) | `run.start` (`agentId`, `agentName`) |
| `text-delta` (never emitted) | `text.delta` (`text`) |
| `text-complete` (`text`, `stepUsage`) | `text.done` (`text`); the step's usage is on `step.done` (`usage`) |
| `tool-call` (`toolCall`) | `tool.start` (`toolCallId`, `toolName`, parsed `args`) |
| `tool-result` (`toolResult`) | `tool.done` (`result`, `durationMs`, `replacedByHook`), or `tool.error` (`error.name`, `error.message`) |
| `error` (`error: Error`) | `error` (`error: { name, message }`) |
| `abort` (`abortReason`, `usage`) | `run.done` with `finishReason: 'aborted'` (the reason is your signal's `reason`) |
| `finish` (`finishReason`, `usage: RunUsage`) | `run.done` (`finishReason`, `text`, `usage`, `object`); the full `RunUsage` is on `result.usage` |
| a sub-agent's `start` / `finish` (with `subagent`) | the lead's `tool.start` / `tool.done` of the call that started it |
| (none: a run was one agent) | `handoff` (`from`, `to`, `toolCallId`): the run handed the conversation to another agent ([Handoffs](./handoffs.md)) |
| `timestamp: Date` | `timestamp`: an ISO-8601 string; plus `runId`, `seq` and `v` |

`AgentEvent` also reports what `ExecutionEvent` never did: step boundaries,
approval requests, permission decisions, budgets, guardrails, queued and
steered input, compaction, reasoning, provider retries, agent drift and handoffs (see the
[schema](./stream-events.md#event-schema-version-1)).

## Streaming a session turn

`session.stream(input, { signal })` streams one turn of a multi-turn
[session](./sessions.md) and returns the same `AgentRun`. The run sees the
conversation so far, and when it ends its turn is saved to the session's
store, just as `session.send()` saves it. `run.done` is delivered after the
save, so the transcript is complete when the loop ends. An aborted or failed
run, or one you stop reading early, is not saved.

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });
const session = agent.session({ id: 'user-42' });

for await (const event of session.stream('My name is Ali.')) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
const again = session.stream('What is my name?'); // streams with the first turn in its history
console.log((await again.result).text);
```

## Streaming after an approval

A run that paused for an [approval](./approvals.md) can continue as a stream
too. `agent.approvals.streamResolve()` (or `streamAnswer()`) returns an
`AgentRun` whose `result` is what `agent.approvals.resolve()` returns. Its events are `run.start`, the decided
call's `tool.resume` and `tool.done` (`tool.error` for a rejection - `tool.resume`,
not a second `tool.start`, because the paused run already reported that call's
start), then the
continuation's events exactly as in a fresh run, up to `run.done`; a further
pause ends it with `approval.requested` (`kind: 'sign-in'` with a `signIn`
link when a tool waits for an [OAuth sign-in](./oauth.md#what-the-user-sees)). Cancellation, `enqueue()` and
`steer()` work as on any run, and the approval can come from another
process, since everything is read from the approval store. A model chosen per
run (`model` as a function) is the one the paused run used.

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ provider /* , a tool with needsApproval */ });
const paused = await agent.send('Delete the old reports.');
// paused.finishReason === 'awaiting-approval'
const run = agent.approvals.streamResolve({ id: paused.approvalId!, approved: true });
for await (const event of run) {
  if (event.type === 'tool.done') console.log(`${event.toolName} ran`);
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
```

#### Advanced: the executor API

With the executor directly, `streamResumeAfterApproval()` takes the arguments
of `resumeAfterApproval()` (see [the executor API](./executor-api.md)) and
returns the same `AgentRun`.

```ts
import { AgentExecutor, streamResumeAfterApproval } from '@lousho/build-ai-agent';

const paused = await AgentExecutor.execute({ agent, input, provider, toolRegistry, approvalStore });
const run = streamResumeAfterApproval({ id: paused.approvalId!, approved: true }, approvalStore, toolRegistry, provider);
for await (const event of run) {
  if (event.type === 'tool.done') console.log(`${event.toolName} ran`);
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
```

Every event has `type`, `runId`, `seq`, `timestamp` and `v`. The full list of event types, the ordering guarantees, the TypeScript helpers and the versioning rules are on [Stream events](./stream-events.md).

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
import { createAgent } from '@lousho/build-ai-agent';

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
`send()`. `send()` and `execute()` stream the same way when they have a
listener (`onEvent` / `onAgentEvent`); without one they use `generate()`.

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
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });
const run = agent.stream('Write a long story');

let chars = 0;
for await (const event of run) {
  if (event.type === 'text.delta') chars += event.text.length;
  if (chars > 500) break; // aborts the run
}
console.log((await run.result).finishReason); // 'aborted'
```

To add input to a run that is still going, or to redirect it, see [Queued input and steering](./queue-and-steer.md): `run.enqueue(input)` waits for the next safe point, `run.steer(input)` interrupts the current model call.

## Example: terminal

```ts
import { createAgent, defineTool } from '@lousho/build-ai-agent';
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
import { createAgent } from '@lousho/build-ai-agent';

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
`useLoushoAgent()` POSTs the input and reads the same `data:` lines.

`lousho dev` serves this format for a session per browser tab: `POST /chat`
with `{ sessionId, input }` streams `agent.session({ id }).stream(input)` as
`data:` lines ending with `event: done`, and approvals are decided through
`POST /chat/:sessionId/approvals/:id` (see [CLI](./cli.md#lousho-dev)).

## Advanced: the executor API

`AgentExecutor.stream()` accepts every `execute()` option (see
[the executor API](./executor-api.md)). Here a tool that
needs approval ends the stream with `approval.requested`:

```ts
import { AgentExecutor } from '@lousho/build-ai-agent';

const run = AgentExecutor.stream({ agent, input, provider, toolRegistry, approvalStore });
for await (const event of run) {
  if (event.type === 'approval.requested') {
    console.log(`Approve ${event.toolName}(${JSON.stringify(event.args)})? id=${event.approvalId}`);
  }
}
const paused = await run.result; // paused.finishReason === 'awaiting-approval'
```
