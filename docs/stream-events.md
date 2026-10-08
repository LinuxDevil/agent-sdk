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
| `reasoning.done`     | `text: string`, `tokens?: number` | The reasoning ended: `text` is all of it; `tokens` when the provider reported reasoning tokens by then. When the model call fails after reasoning only and is retried, the failed attempt's reasoning ends here, before the `provider.retry` event; the retry's reasoning starts again with `reasoning.start`. |
| `tool.start`         | `toolCallId: string`, `toolName: string`, `args: Record<string, unknown>`, `executedBy?: 'provider'`, `parentToolCallId?: string` | A tool call starts. `args` are the model's arguments parsed from JSON (`{}` when they are not valid JSON). A call a [code mode](./code-mode.md) script made carries `parentToolCallId`, the `run_code` call's id (also on its `tool.partial`, `tool.done` and `tool.error`). A [hosted tool](./hosted-tools.md) the provider ran inside the model call carries `executedBy: 'provider'`; it passed no permission rule, guardrail, approval or hook. Exactly one per tool call across a pause: a call that paused for approval (or sign-in) and then ran reports `tool.resume` on the continued run, not a second `tool.start`. |
| `tool.resume`        | `toolCallId`, `toolName`, `args: Record<string, unknown>` | The decided call of [an approval continuation](./streaming.md#streaming-after-an-approval) runs. Its `tool.start` was emitted by the run that paused; handle it like `tool.start` when you track calls. |
| `tool.partial`       | `toolCallId`, `toolName`, `output: unknown`, `index: number` | A snapshot of a running tool's output: a tool whose `execute` is an `async function*` reports one per `yield` (see [Streaming partial results](./tools.md#streaming-partial-results)). Each snapshot is complete and replaces the previous one; `index` counts the call's snapshots from 0. The last one is also the call's `tool.done` `result`. `output` is JSON-encoded like `result`. Snapshots never reach the model, the transcript, checkpoints or traces. A sub-agent's carries `subagent`. |
| `tool.done`          | `toolCallId`, `toolName`, `result: unknown`, `durationMs: number`, `replacedByHook?: string`, `executedBy?: 'provider'` | A tool call returned. `result` is the value as it would be JSON-encoded (`undefined` becomes `null`, a `Date` becomes a string). `durationMs` counts from its `tool.start` / `tool.resume`. `replacedByHook` names the [hook](./hooks.md) whose `{ result }` outcome replaced (or stood in for) the tool's result. A [hosted tool](./hosted-tools.md) call carries `executedBy: 'provider'` and its `result` is capped at 20,000 characters of JSON. |
| `todo.updated`       | `todos: Todo[]`, `counts: { pending, in_progress, completed, total }`, `toolCallId: string` | A successful `todo_write` call of the [todo tools](./tools.md#todo-tools) replaced the list, right after that call's `tool.done`. `todos` is the complete new list (`{ id, content, status }`), `toolCallId` the `todo_write` call. A sub-agent's carries `subagent`. The [UI bindings](./react.md#todos) keep the list and show it live. |
| `tool.error`         | `toolCallId`, `toolName`, `error: { name: string, message: string }`, `durationMs: number`, `executedBy?: 'provider'` | A tool call failed: it threw, its arguments did not match its schema (`name: 'ToolArgumentsValidationError'`), or the tool does not exist. A [hosted tool](./hosted-tools.md) call the provider reported as failed carries `executedBy: 'provider'` and `error.name` is `'HostedToolError'`. The model gets the error as the call's result and the run continues. |
| `approval.requested` | `approvalId: string`, `toolCallId`, `toolName`, `args: Record<string, unknown>`, `kind?: 'question' \| 'sign-in'`, `question?: { text, options?, allowFreeText? }`, `signIn?: { provider, displayName?, url }` | A tool call needs a human decision. The run then stops; resume it with `agent.approvals.resolve()` or `resumeAfterApproval()` (see [Approvals](./approvals.md)), or stream the continuation (see [Streaming after an approval](./streaming.md#streaming-after-an-approval)). An `ask_question` call carries `kind: 'question'` and its `question`; answer it with `agent.approvals.answer()` (see [Asking the user a question](./approvals.md#asking-the-user-a-question)). A tool waiting for an OAuth sign-in carries `kind: 'sign-in'` and the link in `signIn` (see [What the user sees](./oauth.md#what-the-user-sees)). |
| `permission.decision` | `toolCallId`, `toolName`, `decision: 'allow' \| 'deny' \| 'ask' \| 'default'`, `rule?: { index: number, reason?: string }`, `reason?: string`, `hook?: string`, `mode?: 'plan' \| 'acceptEdits' \| 'dontAsk'`, `args?: Record<string, unknown>`, `at: string` | How a tool call's [permission rules](./approvals.md#permission-policies) decided it: after its `tool.start`, before the call's own `tool.done` / `tool.error` / `approval.requested`. `hook` names the `preToolCall` [hook](./hooks.md) that denied the call, `reason` why it (or the tool's `needsApproval`) denied. Only when the run sets `permissions` or `onPermissionDecision`, or a [permission mode](./permission-modes.md) other than `'default'` (`mode` is set when the mode changed the outcome); `args` is left out under `redactContent`. |
| `step.done`          | `step: number`, `finishReason: string`, `usage?: { promptTokens, completionTokens, totalTokens, inputTokens, outputTokens, estimated: boolean, costUsd?: number }` | A step ends. `finishReason` is the model's (`'stop'`, `'tool_calls'`, `'length'`, ...), or `'awaiting-approval'`, `'aborted'`, `'steered'` (its model call was aborted by `run.steer()`, see [Steering](./queue-and-steer.md#steering)) or `'error'` when the step ended that way (a run that runs out of `maxSteps` still wanting to continue ends with `run.done` `'max-steps'`). `usage` is this step's model call, absent when the call produced no response; `promptTokens`/`completionTokens` alias `inputTokens`/`outputTokens`, `estimated` is `true` when the provider reported nothing and the counts are an estimate, and `costUsd` is absent when a model used has unknown pricing. |
| `error`              | `error: { name: string, message: string }` | An error. If it ends the run, `run.done` with `finishReason: 'error'` follows. A provider error retried under `surfaceRetryableProviderErrors` is followed by further steps instead. |
| `provider.retry`     | `attempt: number`, `maxRetries: number`, `delayMs: number`, `error: { message: string, category?: string }`, `provider: string` | A model call failed and is retried after `delayMs` (`createAgent({ retry })` or any `withRetry()` provider). `attempt` is the attempt that failed (1 = first); `category` is `'rate-limit'`, `'timeout'`, ... and absent when unknown (a 5xx, for example). |
| `provider.fallback`  | `from: string`, `to: string`, `error: { message: string }` | A model call still failed after its retries and the next provider takes over (`createAgent({ fallbackModels })` or any `withFallback()` provider). `from` and `to` are provider names. |
| `compaction.start`   | `strategy: string`, `tokensBefore: number`, `contextWindow: number`, `thresholdTokens: number`, `trigger?: 'manual'` | The compaction hook (`createAgent({ compaction })`) found the next model request above its threshold and starts compacting it. Exactly one `compaction.done` follows. `trigger: 'manual'` marks a `session.compact()` call (see `context.cleared`). See [Context compaction](./compaction.md). |
| `compaction.done`    | `strategy: string`, `appliedStrategy?: string`, `tokensBefore: number`, `tokensAfter: number`, `prunedToolCallIds: string[]`, `summary?: boolean`, `error?: { message: string }`, `trigger?: 'manual'` | A compaction ended. `tokensAfter` equals `tokensBefore` when nothing could be compacted; `summary` is set when old turns were replaced by a summary; `error` is set when the strategy failed or fell back (the run continues); `appliedStrategy` names the strategy whose result was applied when it differs from `strategy` (`'prune-tool-results'` after a rejected summary). `trigger: 'manual'` marks a `session.compact()` call. |
| `context.cleared`    | `sessionId: string`, `messagesCleared: number` | `session.clear()` emptied a session's transcript. Delivered to `session.on()` listeners, not to a run's stream. `compaction.start` / `compaction.done` from `session.compact()` also reach `session.on()` and carry `trigger: 'manual'`. |
| `budget.exceeded`    | `limit: string`, `value: number`, `max: number`, `scope: 'run' \| 'session'` | A [`limits` budget](./configuration.md#budgets) tripped: `limit` is `'maxTokens'`, `'maxInputTokens'`, `'maxOutputTokens'`, `'maxCostUsd'`, `'maxDurationMs'` or `'maxSteps'`, `value` what was spent, `max` the limit. `run.done` (`'budget-exceeded'`) follows; with `onExceeded: 'throw'`, `error` and `run.done` (`'error'`). |
| `input.queued`       | `id: string`, `text: string` | `run.enqueue()` took an input (`id` is `EnqueueResult.id`, `text` its user text). Can come at any point of the run, also inside a step. See [Queued input](./queue-and-steer.md#queued-input). |
| `input.steered`      | `id: string`, `text: string`, `mode: 'immediate' \| 'queued'` | `run.steer()` took an input (`id` is `SteerResult.id`). `mode: 'immediate'`: the in-flight model call was aborted for it, and its step ends with `step.done` `'steered'`; `'queued'`: it waits for the next safe point like `enqueue()`. See [Steering](./queue-and-steer.md#steering). |
| `input.applied`      | `id: string`, `step: number` | The queued (or steered) input joined the transcript, right before the model call of `step`: the `step.start` of that step follows. |
| `guardrail.tripped`  | `name: string`, `kind: 'input' \| 'output' \| 'tool'`, `reason: string`, `toolName?: string`, `info?: GuardrailTripInfo` (what tripped: types and offsets, never the matched text; see [the starter set](./guardrails.md#input-and-output-guardrails)) | An [input, output or tool guardrail](./guardrails.md#input-and-output-guardrails) blocked: before the first model call (input), before the step's `text.done` (output) or after the call's `tool.start` (tool). `run.done` (`'guardrail'`) follows; with `onTripped: 'throw'`, `error` and `run.done` (`'error'`). |
| `guardrail.rewrote`  | `name`, `kind`, `reason`, `toolName?`, `info?` | A guardrail rewrote the input, the step's text (before its `text.done`, which carries the new text) or a tool call's arguments. The run continues. |
| `agent.drift`        | `model?: { from?: string, to?: string }`, `toolsAdded: string[]`, `toolsRemoved: string[]`, `toolsChanged: string[]`, `instructions: boolean` | A checkpointed or approval-paused run is being continued by an agent that differs from the one that saved it, and `onAgentDrift` is `'warn'` (the default): what changed. Emitted right after the continuation's `run.start`, before any step or tool event; the run continues. With `'error'` the resume is refused with `LOUSHO_AGENT_DRIFT` instead and this event is not emitted. See [Resuming with a changed agent](./durable-execution.md#resuming-with-a-changed-agent). |
| `handoff`            | `from: string`, `to: string`, `toolCallId: string` | The run handed the conversation to another agent ([Handoffs](./handoffs.md)): after the handoff call's `tool.start` / `tool.done`, before the target's first `step.start`. The run's steps from here on are the target's; `run.result.agentName` names the agent of the final reply. |
| `run.done`           | `finishReason: string`, `text: string`, `usage?: { promptTokens, completionTokens, totalTokens, inputTokens, outputTokens, estimated: boolean, costUsd?: number, modelCalls?: number, hostedToolCalls?: { [tool: string]: number } }`, `object?: unknown` | Last event of every run, exactly once, including aborted, failed and awaiting-approval runs. `finishReason` and `text` match `run.result` (`'max-steps'` when the `maxSteps` budget ran out while the model still wanted to continue); a failed run has `finishReason: 'error'`, `text: ''` and no `usage`. `usage` is the whole run's: `modelCalls` counts its model calls and `hostedToolCalls` the [hosted tool](./hosted-tools.md) calls the provider ran per tool name (their fees are not in `costUsd`). `object` is `run.result`'s validated `object` for an agent with an `output` schema (see [Structured output](./structured-output.md)), absent otherwise. |

Optional fields are left out when they have no value. They are never
`undefined`, so `JSON.parse(JSON.stringify(event))` returns an equal object.

### Ordering guarantees

- `run.start` is first and `run.done` is last, each exactly once.
- Each `step.start` is followed by exactly one `step.done` with the same
  `step`, before the next `step.start`. Everything a step does happens between
  the two. Not every event falls inside a step, though: `agent.drift`, an
  input guardrail's `guardrail.tripped` and the decided call's events of a
  streamed approval continuation (below) all come before the first or between
  `step.start`s, and `context.cleared` goes to `session.on()`, not to a run.
- Inside a step: `compaction.start` / `compaction.done` (if the request was
  compacted, before the model call), `provider.retry` / `provider.fallback`
  events (if the model call fails), then `text.delta` events, then `text.done`, then the tool events.
- Tool calls of one step run in parallel (see `toolConcurrency`):
  `tool.start` events come in the model's call order and `tool.done` /
  `tool.error` events in completion order. Match them by `toolCallId`.
- A `run_code` call's inner calls ([code mode](./code-mode.md)) start and
  settle between its own `tool.start` and its `tool.done` / `tool.error`.
- A call's `tool.partial` events come between its `tool.start` and its
  `tool.done` / `tool.error`, with `index` 0, 1, 2, ...; the partials of
  parallel calls interleave. A call that pauses for a sign-in or an approval
  has no `tool.done`; it runs again from the start once decided, reported as
  `tool.resume` (not a second `tool.start`) with `index` from 0.
- `input.queued` comes when `run.enqueue()` is called (after `run.start`, even
  for input queued before the run got going), so it can fall inside a step.
  Its `input.applied` comes between the `step.done` of the step that was
  running and the next `step.start`, which carries the `step` it names.
- `input.steered` comes when `run.steer()` is called. With `mode: 'immediate'`
  the running step ends next with `step.done` (`'steered'`, no text events
  from its aborted call), then `input.applied` and the next `step.start`.
- When a call needs approval, the calls before it run and report, then
  `approval.requested`, `step.done` (`'awaiting-approval'`) and `run.done`
  (`'awaiting-approval'`) follow. Calls after it never start. A run continued
  as a stream (`agent.approvals.streamResolve()` / `streamAnswer()`, see
  [Streaming after an approval](./streaming.md#streaming-after-an-approval))
  is a new stream: it reports its own `run.start`, then `agent.drift` when the
  agent changed, then the decided call's `tool.resume` and `tool.done`
  (`tool.error` for a rejection) before its first `step.start` — a consumer
  following both streams sees that call's `tool.start` once, in the run that
  paused.
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
