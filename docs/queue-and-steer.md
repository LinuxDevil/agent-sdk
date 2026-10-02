# Queued input and steering

Add input to a run that is still going, or redirect it. Both are methods of the run handle that `agent.stream()` returns; see [Streaming](./streaming.md).

## Queued input

`run.enqueue(input)` adds user input (a string, content parts or a
`Message[]`) to a run that is still going, for example a follow-up the user
types while the agent works. The run does not stop: the input joins the
transcript at the next safe point - after the current step's tool results,
never between a tool-call turn and its results - and the next model call sees
it, as if the user had typed it. Input queued while the model writes its final
reply gets one more step, so the model answers it in the same run.

```ts
import { createAgent } from '@lousho/build-ai-agent';

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

Queued input waits for the step that is running. To redirect the run at
once, steer it (next section).

#### Advanced: the executor API

Without a stream, pass an `InputQueue` to `AgentExecutor.execute()` (see
[the executor API](./executor-api.md)):

```ts
import { AgentExecutor, InputQueue } from '@lousho/build-ai-agent';

const inputQueue = new InputQueue();
const pending = AgentExecutor.execute({ agent, provider, input: 'Plan my trip.', inputQueue });
inputQueue.push('Also book a hotel.');
const result = await pending;
```

## Steering

`run.steer(input)` redirects a running run to new user input, for example when
the user changes their mind while the agent is still thinking:

- If a model call is in flight and has not emitted text or tool calls yet, it
  is aborted (with a signal of its own, not the run's: the run goes on), its
  partial output is discarded, `input` is appended as a user message and the
  model is called again. `applied` is `'immediate'`, and the aborted call's
  step ends with `step.done` `'steered'`. A provider that ignores the abort
  signal is not waited for; its late reply is dropped.
- If the model has already emitted text (or tool calls), `input` waits for the
  next safe point like [`enqueue()`](#queued-input): `applied` is `'queued'`.
- Tool calls already running finish and their results are kept; calls of that
  turn that have not started yet are not run and get the usual "cancelled
  before it ran" result. Then the input is applied.
- `applied` is `false` once the run has finished: send the input as a new turn.

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });
const run = agent.stream('Plan a weekend in Rome.');

const steered = run.steer('Actually, make it Paris.');
console.log(steered.applied); // 'immediate', 'queued' or false
for await (const event of run) {
  if (event.type === 'input.steered') console.log(`steered (${event.mode})`);
}
console.log(await steered.joined); // true once the input is in the transcript
```

`steer()` returns `{ id, applied, joined }`: `id` is on the `input.steered` and
`input.applied` events, and `joined` is a promise of whether the input made it
into the transcript (as `enqueue()`'s `applied`). The aborted call counts as a
step of `maxSteps`. With checkpointing, the input is saved at the end of the
checkpoint as soon as it is taken and before the model is called again, so a
crash during the redirect does not lose it; the discarded partial turn is never
checkpointed. Without a stream, call `steer()` on the run's
`ExecuteOptions.inputQueue`. In a session, `agent.session({ turnPolicy: 'steer' })`
makes a `send()` or `stream()` made while a turn runs steer that turn (see
[Sessions](./sessions.md#the-session-object)).
