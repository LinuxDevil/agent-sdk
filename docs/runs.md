# Runs: finish reasons, cancellation and parallel tools

How a run ends, how to stop one, and how tool calls of one model turn run in parallel.

## Finish reasons

`result.finishReason` says why a run ended: the model's own reason for its last
turn (`'stop'`, `'length'`, `'tool_calls'`, `'content_filter'`, `'error'`),
`'awaiting-approval'` (paused on a tool call that needs a human), `'aborted'`
(cancelled with `signal`), `'max-steps'`, `'output-invalid'` (the reply
did not match the `output` schema even after the repair step, see
[Structured output](./structured-output.md)), `'budget-exceeded'` (a
`limits` budget such as `maxTokens` or `maxCostUsd` tripped; `result.budget`
says which, see [Budgets](./configuration.md#budgets)), or `'guardrail'` (an
input, output or tool guardrail blocked; `result.guardrail` says which, see
[Input and output guardrails](./guardrails.md#input-and-output-guardrails)). `'max-steps'` means the `maxSteps`
budget (default 10) ran out while the model still wanted to continue, so the
reply may be empty or partial; a run that finishes naturally within the budget
keeps its `'stop'`. Steps carried over by `initialSteps` or an approval resume
count against the budget, and `result.steps` is the number of steps taken. The
same reason is on the `finish` event and on `run.done` in
[streaming](streaming.md).

```ts
import { createAgent, createMockProvider } from '@lousho/build-ai-agent';
const agent = createAgent({ prompt: 'You are helpful.', provider: createMockProvider(), maxSteps: 3 });
const result = await agent.send('Research this thoroughly');
if (result.finishReason === 'max-steps') console.warn(`Gave up after ${result.steps} steps`);
```

## Cancellation

Pass an `AbortSignal` to stop a run: `agent.send(input, { signal })`,
`AgentExecutor.execute({ ..., signal })` or
`resumeAfterApproval(..., { signal })`.

```ts
import { createAgent, createMockProvider } from '@lousho/build-ai-agent';
const agent = createAgent({ prompt: 'You are helpful.', provider: createMockProvider() });
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000); // e.g. from a Stop button
const result = await agent.send('Write a long report', { signal: controller.signal });
console.log(result.finishReason); // 'aborted' if it was cancelled, else 'stop'
```

For a time limit, use `AbortSignal.timeout(ms)`:

```ts
import { createAgent, createMockProvider } from '@lousho/build-ai-agent';
const agent = createAgent({ prompt: 'You are helpful.', provider: createMockProvider() });
const result = await agent.send('Summarize this', { signal: AbortSignal.timeout(30_000) });
```

How it behaves:

- The signal is checked before every model call and every tool call. It is
  passed to the provider (`GenerateOptions.signal`, sent to the `ai` SDK as
  `abortSignal`) and to each tool as `execute(args, { abortSignal })`, so
  in-flight work can stop early. The built-in `httpTool` passes it to
  `fetch`, and agents created with `createDelegateTool()` are aborted along
  with their parent.
- An aborted run **resolves** (it does not reject) with
  `finishReason: 'aborted'` and the messages and steps so far. A rejection
  caused by the abort, such as an `AbortError`, is not treated as a failure:
  it is not retried by the provider retry and fallback wrappers and is not
  compacted into a provider error.
- The run's events end with `run.done` with `finishReason: 'aborted'`.
- With `sessionId` + `checkpointStore`, the state is checkpointed. Calling
  `execute()` again with the same `sessionId` resumes where the run stopped;
  new `input` is appended as the next user message (see
  [Durable execution](./durable-execution.md)). Tool calls the run never
  reached get an `{ error }` result saying they were cancelled, so the
  conversation stays valid for the provider.
- An already-aborted signal returns at once without calling the provider.

## Parallel tool calls

When the model asks for several tools in one turn, they run concurrently.
`toolConcurrency` (on `createAgent()` and `AgentExecutor.execute()`) caps how
many run at once: a positive integer, or `'unbounded'` (the default). Use `1`
for strictly sequential execution, e.g. when your tools share state that is
not safe to touch concurrently.

```ts
import { createAgent, createMockProvider, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

const getWeather = defineTool({
  name: 'get_weather',
  description: 'Current weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21 }),
});

const agent = createAgent({
  prompt: 'You are a travel assistant.',
  provider: createMockProvider(),
  tools: [getWeather],
  toolConcurrency: 4, // at most 4 tool calls of a turn in flight
});
```

Guarantees, whatever the limit:

- **Transcript order is call order.** Tool results are appended in the order
  the model requested the calls, not the order they finish, so the next
  provider request is deterministic.
- **Events.** Calls start in call order. A call's `tool-call` event,
  `onToolCall`, argument validation, `preToolCall` hooks and `needsApproval`
  check run just before it starts, one call at a time. Its `tool-result`
  event fires when it finishes, so results arrive in completion order. With
  `toolConcurrency: 1` events alternate call/result exactly as before.
- **Approvals.** The first call that needs approval stops the batch: the
  calls before it run (concurrently) and their results are recorded, then the
  run pauses on that call (`finishReason: 'awaiting-approval'`). Calls after
  it never start in this run. `resumeAfterApproval()` records the paused
  call's result (or rejection) and then runs those later calls the same way,
  so every call of the turn gets exactly one result - see
  [Durable execution](./durable-execution.md#approvals-in-the-middle-of-a-tool-batch).
- **Failures are isolated.** A tool that throws gets its own error result;
  its siblings carry on. A propagating error (`PropagatingToolError`, such as
  the delegation depth guard, or a throwing hook) stops new calls from
  starting, waits for the running ones to settle, then rejects the run. No
  tool is left running detached.
- **Cancellation.** An abort while a batch runs resolves with
  `finishReason: 'aborted'`. Calls that finished keep their results; the rest
  get a "cancelled" result. Running tools see the abort through their
  `abortSignal`.
- **Checkpoints.** With `sessionId` + `checkpointStore`, the model's turn is
  checkpointed before any call starts, then again each time the in-order run
  of finished calls grows (with `1`, after every call). A resumed run never
  runs a recorded call again, and never asks the model again for a turn it
  already checkpointed.
