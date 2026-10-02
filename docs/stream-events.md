# Stream events

The events `agent.stream()` emits, their order and their versioning. For how to consume a stream, see [Streaming](./streaming.md).

## Event schema (version 1)

Every event has these fields:

| Field       | Type     | Meaning |
| ----------- | -------- | ------- |
| `type`      | string   | The event type (table below). Narrow on it in TypeScript. |
| `runId`     | string   | Identifies the run. The same on every event of one `stream()` call. |
| `seq`       | number   | `0` for the first event, then `+1` per event, with no gaps. |
| `timestamp` | string   | When the event was emitted, ISO 8601 (`2026-10-01T09:30:00.000Z`). |
| `v`         | `1`      | Schema version, exported as `AGENT_EVENT_SCHEMA_VERSION`. |
| `subagent`  | object, optional | Only on events of a sub-agent's run - see [Sub-agents](./streaming.md#sub-agents). |

The event types and their extra fields:

| `type`               | Extra fields | Emitted |
| -------------------- | ------------ | ------- |
| `run.start`          | `agentName: string`, `agentId?: string` | First event of every run. |
| `step.start`         | `step: number` | A model step begins: one model call plus the tool calls it asks for. `step` counts from 1 (a run resumed from a checkpoint continues the count). |
| `text.delta`         | `text: string` | A chunk of model text, as it arrives. |
| `text.done`          | `text: string` | The step's complete text: the concatenation of its `text.delta` events. Only for steps with text. |
| `reasoning.start`    | (none) | The model starts reasoning in this step. Only with the [`reasoning` option](./reasoning.md) (or a model that always reasons). Its `reasoning.delta`s and `reasoning.done` follow, before the step's first `text.delta` or `tool.start`. |
| `reasoning.delta`    | `text: string` | A chunk of reasoning text (or of its summary). Never part of `text.delta` / `run.done`'s `text`. |
| `reasoning.done`     | `text: string`, `tokens?: number` | The reasoning ended: `text` is all of it; `tokens` when the provider reported reasoning tokens by then. |
| `tool.start`         | `toolCallId: string`, `toolName: string`, `args: Record<string, unknown>` | A tool call starts. `args` are the model's arguments parsed from JSON (`{}` when they are not valid JSON). |
| `tool.done`          | `toolCallId`, `toolName`, `result: unknown`, `durationMs: number` | A tool call returned. `result` is the value as it would be JSON-encoded (`undefined` becomes `null`, a `Date` becomes a string). `durationMs` counts from its `tool.start`. |
| `todo.updated`       | `todos: Todo[]`, `counts: { pending, in_progress, completed, total }`, `toolCallId: string` | A successful `todo_write` call of the [todo tools](./tools.md#todo-tools) replaced the list, right after that call's `tool.done`. `todos` is the complete new list (`{ id, content, status }`), `toolCallId` the `todo_write` call. A sub-agent's carries `subagent`. The [UI bindings](./react.md#todos) keep the list and show it live. |
| `tool.error`         | `toolCallId`, `toolName`, `error: { name: string, message: string }`, `durationMs: number` | A tool call failed: it threw, its arguments did not match its schema (`name: 'ToolArgumentsValidationError'`), or the tool does not exist. The model gets the error as the call's result and the run continues. |
| `approval.requested` | `approvalId: string`, `toolCallId`, `toolName`, `args: Record<string, unknown>`, `kind?: 'question'`, `question?: { text, options?, allowFreeText? }` | A tool call needs a human decision. The run then stops; resume it with `agent.approvals.resolve()` or `resumeAfterApproval()` (see [Approvals](./approvals.md)), or stream the continuation (see [Streaming after an approval](./streaming.md#streaming-after-an-approval)). An `ask_question` call carries `kind: 'question'` and its `question`; answer it with `agent.approvals.answer()` (see [Asking the user a question](./approvals.md#asking-the-user-a-question)). |
| `permission.decision` | `toolCallId`, `toolName`, `decision: 'allow' \| 'deny' \| 'ask' \| 'default'`, `rule?: { index: number, reason?: string }`, `args?: Record<string, unknown>`, `at: string` | How a tool call's [permission rules](./approvals.md#permission-policies) decided it: after its `tool.start`, before the call's own `tool.done` / `tool.error` / `approval.requested`. Only when the run sets `permissions` or `onPermissionDecision`; `args` is left out under `redactContent`. |
| `step.done`          | `step: number`, `finishReason: string`, `usage?: { promptTokens, completionTokens, totalTokens }` | A step ends. `finishReason` is the model's (`'stop'`, `'tool_calls'`, `'length'`, ...), or `'awaiting-approval'`, `'aborted'`, `'steered'` (its model call was aborted by `run.steer()`, see [Steering](./queue-and-steer.md#steering)) or `'error'` when the step ended that way (a run that runs out of `maxSteps` still wanting to continue ends with `run.done` `'max-steps'`). `usage` is this step's model call, absent when the call produced no response. |
| `error`              | `error: { name: string, message: string }` | An error. If it ends the run, `run.done` with `finishReason: 'error'` follows. A provider error retried under `surfaceRetryableProviderErrors` is followed by further steps instead. |
| `provider.retry`     | `attempt: number`, `maxRetries: number`, `delayMs: number`, `error: { message: string, category?: string }`, `provider: string` | A model call failed and is retried after `delayMs` (`createAgent({ retry })` or any `withRetry()` provider). `attempt` is the attempt that failed (1 = first); `category` is `'rate-limit'`, `'timeout'`, ... and absent when unknown (a 5xx, for example). |
| `provider.fallback`  | `from: string`, `to: string`, `error: { message: string }` | A model call still failed after its retries and the next provider takes over (`createAgent({ fallbackModels })` or any `withFallback()` provider). `from` and `to` are provider names. |
| `compaction.start`   | `strategy: string`, `tokensBefore: number`, `contextWindow: number`, `thresholdTokens: number` | The compaction hook (`createAgent({ compaction })`) found the next model request above its threshold and starts compacting it. Exactly one `compaction.done` follows. See [Context compaction](./compaction.md). |
| `compaction.done`    | `strategy: string`, `tokensBefore: number`, `tokensAfter: number`, `prunedToolCallIds: string[]`, `summary?: boolean`, `error?: { message: string }` | A compaction ended. `tokensAfter` equals `tokensBefore` when nothing could be compacted; `summary` is set when old turns were replaced by a summary; `error` is set when the strategy failed or fell back (the run continues). |
| `context.cleared`    | `sessionId: string`, `messagesCleared: number` | `session.clear()` emptied a session's transcript. Delivered to `session.on()` listeners, not to a run's stream. `compaction.start` / `compaction.done` from `session.compact()` also reach `session.on()` and carry `trigger: 'manual'`. |
| `budget.exceeded`    | `limit: string`, `value: number`, `max: number`, `scope: 'run' \| 'session'` | A [`limits` budget](./configuration.md#budgets) tripped: `limit` is `'maxTokens'`, `'maxInputTokens'`, `'maxOutputTokens'`, `'maxCostUsd'`, `'maxDurationMs'` or `'maxSteps'`, `value` what was spent, `max` the limit. `run.done` (`'budget-exceeded'`) follows; with `onExceeded: 'throw'`, `error` and `run.done` (`'error'`). |
| `input.queued`       | `id: string`, `text: string` | `run.enqueue()` took an input (`id` is `EnqueueResult.id`, `text` its user text). Can come at any point of the run, also inside a step. See [Queued input](./queue-and-steer.md#queued-input). |
| `input.steered`      | `id: string`, `text: string`, `mode: 'immediate' \| 'queued'` | `run.steer()` took an input (`id` is `SteerResult.id`). `mode: 'immediate'`: the in-flight model call was aborted for it, and its step ends with `step.done` `'steered'`; `'queued'`: it waits for the next safe point like `enqueue()`. See [Steering](./queue-and-steer.md#steering). |
| `input.applied`      | `id: string`, `step: number` | The queued (or steered) input joined the transcript, right before the model call of `step`: the `step.start` of that step follows. |
| `guardrail.tripped`  | `name: string`, `kind: 'input' \| 'output' \| 'tool'`, `reason: string`, `toolName?: string`, `info?: GuardrailTripInfo` (what tripped: types and offsets, never the matched text; see [the starter set](./guardrails.md#input-and-output-guardrails)) | An [input, output or tool guardrail](./guardrails.md#input-and-output-guardrails) blocked: before the first model call (input), before the step's `text.done` (output) or after the call's `tool.start` (tool). `run.done` (`'guardrail'`) follows; with `onTripped: 'throw'`, `error` and `run.done` (`'error'`). |
| `guardrail.rewrote`  | `name`, `kind`, `reason`, `toolName?`, `info?` | A guardrail rewrote the input, the step's text (before its `text.done`, which carries the new text) or a tool call's arguments. The run continues. |
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
- `input.steered` comes when `run.steer()` is called. With `mode: 'immediate'`
  the running step ends next with `step.done` (`'steered'`, no text events
  from its aborted call), then `input.applied` and the next `step.start`.
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
import { isAgentEvent, isToolEvent, type AgentEvent } from '@lousho/build-ai-agent';

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
