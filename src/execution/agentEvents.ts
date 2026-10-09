/**
 * LOU-V2: the typed, versioned event schema of `agent.stream()` /
 * `AgentExecutor.stream()`. Every event is a plain JSON value (no `Error`
 * instances, no functions, no `undefined` fields), so it can be sent over
 * SSE or a WebSocket unchanged and parsed back to the same object.
 *
 * See docs/stream-events.md for the full table - this file is the public schema.
 */

import type { ExecutionFinishReason } from './AgentExecutor';
import type { SubagentInfo } from './hooks';
import type { CompactedProviderErrorCategory } from './errors';
import type { PermissionDecisionEntry } from './permissions';
import type { ApprovalKind, ApprovalQuestion, ApprovalSignIn } from './ApprovalGate';
import type { BudgetExceeded } from './budget';
import type { GuardrailTrip } from './ioGuardrails';
import type { AgentDrift } from './agentFingerprint';
import type { Todo, TodoListResult } from '../tools/built-in/todo';

/**
 * Version of the {@link AgentEvent} schema, carried on every event as `v`.
 * It changes only on a breaking change to an existing event (a field removed,
 * renamed or retyped); new event types and new optional fields keep it.
 */
export const AGENT_EVENT_SCHEMA_VERSION = 1 as const;

/** Token usage, as reported on `step.done` and `run.done`. */
export interface AgentEventUsage {
  /** Alias of `inputTokens`. */
  promptTokens: number;
  /** Alias of `outputTokens`. */
  completionTokens: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** `true` when the provider reported no usage and the tokens are an `estimateTokens` estimate. */
  estimated: boolean;
  /** USD, or absent when a model used has unknown pricing (see `registerModel`). */
  costUsd?: number;
  /** On `run.done`: model calls of the whole run. */
  modelCalls?: number;
  /** N1a, on `run.done`: hosted tool calls the provider ran, per tool name; absent when none. Their fees are not in `costUsd`. */
  hostedToolCalls?: Partial<Record<string, number>>;
}

/** A JSON-safe error: the `name` and `message` of the original error. */
export interface AgentEventError {
  name: string;
  message: string;
  /** A1: the error's `code` (e.g. `'LOUSHO_APPROVAL_NOT_FOUND'`), when it has a string one. */
  code?: string;
}

/** Fields every {@link AgentEvent} carries. */
export interface AgentEventBase<TType extends string> {
  /** Discriminant: narrow on it to get the event's payload. */
  type: TType;
  /** Identifies the run; the same on every event of one `stream()` call. */
  runId: string;
  /** 0 for the first event of the run, then +1 per event, with no gaps. */
  seq: number;
  /** When the event was emitted, as an ISO-8601 string. */
  timestamp: string;
  /** Schema version, always {@link AGENT_EVENT_SCHEMA_VERSION}. */
  v: typeof AGENT_EVENT_SCHEMA_VERSION;
  /**
   * LOU-Y1: set on events of a sub-agent's run (started by the `task` tool):
   * which sub-agent, and the tool call of this run that started it. Absent on the top-level run's own events, and never
   * set on `run.start`/`run.done` (they mark the top-level run only). The step
   * ordering guarantees hold for the top-level events and, separately, for
   * each sub-agent's events.
   */
  subagent?: SubagentInfo;
}

/** First event of every run. */
export interface RunStartEvent extends AgentEventBase<'run.start'> {
  agentName: string;
  /** The agent's id, when it has one. */
  agentId?: string;
}

/** A model step (one model call plus the tool calls it asked for) begins. `step` counts from 1. */
export interface StepStartEvent extends AgentEventBase<'step.start'> {
  step: number;
}

/** A chunk of model text, emitted as it arrives. */
export interface TextDeltaEvent extends AgentEventBase<'text.delta'> {
  text: string;
}

/**
 * Eve CORE-F13: for an agent with an `output` schema, the reply parsed so far
 * - a best-effort partial object (an unfinished string value is cut where the
 * text is; an unfinished key or number is left out). Emitted after a
 * `text.delta` that changes it. Not validated against the schema: the
 * validated object is `run.done`'s `object` (and `result.object`).
 */
export interface ObjectDeltaEvent extends AgentEventBase<'object.delta'> {
  object: unknown;
}

/** The complete text of the current step (the concatenation of its `text.delta`s). */
export interface TextDoneEvent extends AgentEventBase<'text.done'> {
  text: string;
}

/**
 * LOU-V13: the model starts reasoning (thinking) in this step. Its
 * `reasoning.delta`s and `reasoning.done` follow, before the step's first
 * `text.delta` or `tool.start`. Only models given the `reasoning` option
 * (and some that always reason) emit them.
 */
export type ReasoningStartEvent = AgentEventBase<'reasoning.start'>;

/** LOU-V13: a chunk of reasoning text (or of its summary), as it arrives. Never part of `text`. */
export interface ReasoningDeltaEvent extends AgentEventBase<'reasoning.delta'> {
  text: string;
}

/** LOU-V13: the reasoning ended; `text` is the concatenation of its `reasoning.delta`s. */
export interface ReasoningDoneEvent extends AgentEventBase<'reasoning.done'> {
  text: string;
  /** Reasoning tokens, when the provider reported them by the time the reasoning ended. */
  tokens?: number;
}

/** A tool call starts. Emitted in the model's call order. */
export interface ToolStartEvent extends AgentEventBase<'tool.start'> {
  toolCallId: string;
  toolName: string;
  /**
   * The arguments the model sent, parsed from JSON (`{}` when they are not
   * valid JSON; the call then fails with a validation error the model sees).
   */
  args: Record<string, unknown>;
  /**
   * The raw `arguments` text, set only when it was not valid JSON as sent:
   * it failed to parse, or parsed only after a repair (a markdown code
   * fence, trailing commas, double-encoded JSON).
   */
  rawArgs?: string;
  /**
   * N1a: `'provider'` for a hosted tool (`webSearch()`, ...) the provider ran
   * inside the model call; absent for a tool the SDK ran. A provider-run call
   * passed no permission rule, guardrail, approval or hook.
   */
  executedBy?: 'provider';
  /** N14: set on a call a `run_code` script made: the `run_code` call's id. */
  parentToolCallId?: string;
}

/**
 * The call a run paused on for approval (or sign-in) runs, now that it is
 * decided. Its `tool.start` was emitted by the run that paused, so the
 * continued run reports `tool.resume` instead of a second `tool.start`:
 * every tool call still has exactly one `tool.start` across a pause. Its
 * `tool.partial` indexes count from 0 again and its `tool.done` /
 * `tool.error` measures from this event.
 */
export interface ToolResumeEvent extends AgentEventBase<'tool.resume'> {
  toolCallId: string;
  toolName: string;
  /** The approved arguments, parsed like `tool.start`'s (`{}` when they are not valid JSON). */
  args: Record<string, unknown>;
  /** Same shape as `tool.start`'s; absent - a provider-run call never pauses for approval. */
  executedBy?: 'provider';
}

/**
 * N13b: a snapshot of a running tool's output - a tool whose `execute` is an
 * `async function*` yields one per `yield`. Each snapshot is complete and
 * replaces the previous one; the last one is also the result in `tool.done`.
 * Snapshots are not sent to the model, not added to the transcript and not
 * checkpointed. Emitted between the call's `tool.start` and its `tool.done` /
 * `tool.error`.
 */
export interface ToolPartialEvent extends AgentEventBase<'tool.partial'> {
  toolCallId: string;
  toolName: string;
  /** The snapshot as it would be JSON-encoded (`undefined` becomes `null`). */
  output: unknown;
  /** Counts this call's snapshots from 0 (from 0 again when the call runs again, e.g. after a sign-in). */
  index: number;
  /** N14: set on a call a `run_code` script made: the `run_code` call's id. */
  parentToolCallId?: string;
}

/** A tool call returned. Emitted in completion order. */
export interface ToolDoneEvent extends AgentEventBase<'tool.done'> {
  toolCallId: string;
  toolName: string;
  /** The tool's result as it would be JSON-encoded (`undefined` becomes `null`). */
  result: unknown;
  /** Milliseconds since this call's `tool.start`. */
  durationMs: number;
  /** LOU-X3: the hook whose `{ result }` outcome replaced (or stood in for) the tool's result. */
  replacedByHook?: string;
  /** N1a: `'provider'` for a hosted tool's call (see `tool.start`); `result` is capped at 20,000 characters of JSON. */
  executedBy?: 'provider';
  /** N14: set on a call a `run_code` script made: the `run_code` call's id. */
  parentToolCallId?: string;
}

/**
 * A successful `todo_write` replaced the todo list; emitted right after that
 * call's `tool.done` (also for a sub-agent's, with `subagent`). `todos` is the
 * complete new list.
 */
export interface TodoUpdatedEvent extends AgentEventBase<'todo.updated'> {
  todos: Todo[];
  counts: TodoListResult['counts'];
  /** The `todo_write` call that made the change. */
  toolCallId: string;
}

/**
 * A tool call failed (it threw, its arguments were invalid, or the tool does
 * not exist). The model receives the error as the call's result and the run
 * continues.
 */
export interface ToolErrorEvent extends AgentEventBase<'tool.error'> {
  toolCallId: string;
  toolName: string;
  error: AgentEventError;
  /** Milliseconds since this call's `tool.start`. */
  durationMs: number;
  /** N1a: `'provider'` for a hosted tool's call the provider reported as failed (see `tool.start`). */
  executedBy?: 'provider';
  /** N14: set on a call a `run_code` script made: the `run_code` call's id. */
  parentToolCallId?: string;
}

/**
 * A tool call needs a human decision. The run then ends with
 * `run.done { finishReason: 'awaiting-approval' }`; resume it with
 * `resumeAfterApproval(approvalId, ...)`.
 */
export interface ApprovalRequestedEvent extends AgentEventBase<'approval.requested'> {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** LOU-X9: `'question'` when an `ask_question` call waits for the user's answer; N9b: `'sign-in'` when a tool waits for an OAuth sign-in; absent for a tool approval. */
  kind?: ApprovalKind;
  /** LOU-X9: the question's text and options, when `kind` is `'question'`. */
  question?: ApprovalQuestion;
  /**
   * N9b: where the user signs in, when `kind` is `'sign-in'`: a tool needs an
   * OAuth token the user has not granted yet. Show `url`; once the provider
   * redirected back, continue with `approved: true` ("I've signed in").
   */
  signIn?: ApprovalSignIn;
  /**
   * TTL: when the pause stops being decidable (ISO-8601), from the run's
   * `approvalTtlMs` or the `ask` rule's `ttlMs`. A decision after it denies
   * the call ('approval expired'). Absent: the approval never expires.
   */
  expiresAt?: string;
}

/**
 * LOU-X2: how a tool call's permission was decided - by the first matching
 * rule of `permissions` (`allow`, `deny`, `ask`) or `'default'` when none
 * matched. Emitted after `tool.start` when the run sets `permissions` or
 * `onPermissionDecision`; carries the same audit entry `onPermissionDecision` gets.
 */
export interface PermissionDecisionEvent extends AgentEventBase<'permission.decision'>, PermissionDecisionEntry {}

/** A step ends. Every `step.start` is followed by exactly one `step.done`. */
export interface StepDoneEvent extends AgentEventBase<'step.done'> {
  step: number;
  /**
   * The model's finish reason for this step (`'stop'`, `'tool_calls'`, ...),
   * or `'awaiting-approval'`, `'aborted'`, `'steered'` (LOU-V10: its model call
   * was aborted by `run.steer()`) or `'error'` when the step ended that way.
   */
  finishReason: ExecutionFinishReason | 'steered';
  /** Tokens used by this step's model call, when it produced a response. */
  usage?: AgentEventUsage;
}

/**
 * An error. When it ends the run, `run.done { finishReason: 'error' }`
 * follows; a provider error retried under `surfaceRetryableProviderErrors`
 * is followed by more steps instead.
 */
export interface AgentErrorEvent extends AgentEventBase<'error'> {
  error: AgentEventError;
}

/**
 * A model call failed and a `withRetry()` wrapper (e.g. `createAgent({ retry })`)
 * retries it after `delayMs` (LOU-V7.2). Emitted inside the step, before
 * the retried call.
 */
export interface ProviderRetryEvent extends AgentEventBase<'provider.retry'> {
  /** The attempt that failed (1 = the first call). */
  attempt: number;
  /** Retries the wrapper allows after the first attempt. */
  maxRetries: number;
  /** How long the wrapper waits before the next attempt. */
  delayMs: number;
  /** The failure, compacted like `compactProviderError()`; `category` (e.g. `'rate-limit'`) is absent when it is `'unknown'`. */
  error: { message: string; category?: CompactedProviderErrorCategory };
  /** Name of the provider that failed. */
  provider: string;
}

/**
 * A model call failed (after its retries) and the next provider of a
 * `withFallback()` wrapper (e.g. `createAgent({ fallbackModels })`) takes
 * over the call (LOU-V7.2). Emitted inside the step.
 */
export interface ProviderFallbackEvent extends AgentEventBase<'provider.fallback'> {
  /** Name of the provider that failed. */
  from: string;
  /** Name of the provider that takes over. */
  to: string;
  error: { message: string };
}

/**
 * The compaction hook (`createAgent({ compaction })`, `createCompactionHook()`)
 * found the next model request above its threshold and starts compacting it
 * (LOU-W3.2). Emitted inside the step, before the model call; exactly one
 * `compaction.done` follows.
 */
export interface CompactionStartEvent extends AgentEventBase<'compaction.start'> {
  /** The strategy's name, e.g. `'prune-tool-results'` or `'two-phase'`. */
  strategy: string;
  /** Estimated tokens of the request before compaction. */
  tokensBefore: number;
  /** The model's context window, in tokens. */
  contextWindow: number;
  /** The size (`thresholdPercent` of the window) the request is compared with. */
  thresholdTokens: number;
  /** `'manual'` for `session.compact()` (LOU-W8); absent for the hook's automatic compaction. */
  trigger?: 'manual';
}

/**
 * A compaction ended (LOU-W3.2). `tokensAfter` equals `tokensBefore` when
 * nothing could be compacted. `error` is set when the strategy failed or fell
 * back (e.g. the summarizer failed and only tool results were pruned); the
 * run continues either way.
 */
export interface CompactionDoneEvent extends AgentEventBase<'compaction.done'> {
  /** The strategy that ran: the same as the `compaction.start` before it. */
  strategy: string;
  /**
   * The strategy whose result was applied, when it differs from `strategy`:
   * `'prune-tool-results'` when a summary was rejected and pruning applied instead.
   */
  appliedStrategy?: string;
  tokensBefore: number;
  tokensAfter: number;
  /** `toolCallId`s whose results were replaced by a marker. */
  prunedToolCallIds: string[];
  /** `true` when old turns were replaced by a model-written summary (the text is not sent). */
  summary?: boolean;
  error?: { message: string };
  /**
   * `true` when the strategy could not change anything (Eve MEM-F14). The
   * hook then compacts that transcript quietly: no events until an attempt
   * changes something, so a run stuck over the threshold does not report a
   * start/done pair on every step.
   */
  unchanged?: boolean;
  /** `'manual'` for `session.compact()` (LOU-W8); absent for the hook's automatic compaction. */
  trigger?: 'manual';
}

/**
 * `session.clear()` emptied a session's transcript (LOU-W8). Delivered to
 * `session.on()` listeners, not to a run's stream; `runId` is `session:<id>`.
 */
export interface ContextClearedEvent extends AgentEventBase<'context.cleared'> {
  sessionId: string;
  /** How many messages the transcript held. */
  messagesCleared: number;
}

/**
 * A `limits` budget tripped (LOU-V6): which limit, what was spent and its
 * maximum. `run.done { finishReason: 'budget-exceeded' }` follows (or, with
 * `onExceeded: 'throw'`, `error` and `run.done { finishReason: 'error' }`).
 */
export interface BudgetExceededEvent extends AgentEventBase<'budget.exceeded'>, BudgetExceeded {}

/** LOU-V9: `run.enqueue()` took an input; `input.applied` follows when it joins the transcript. */
export interface InputQueuedEvent extends AgentEventBase<'input.queued'> {
  /** `EnqueueResult.id`. */
  id: string;
  /** The input's user text. */
  text: string;
}

/**
 * LOU-V10: `run.steer()` took an input. `mode` is `'immediate'` when the
 * in-flight model call was aborted for it (that step ends with `step.done`
 * `'steered'`), `'queued'` when it waits for the next safe point.
 * `input.applied` follows when it joins the transcript.
 */
export interface InputSteeredEvent extends AgentEventBase<'input.steered'> {
  /** `SteerResult.id`. */
  id: string;
  text: string;
  mode: 'immediate' | 'queued';
}

/** LOU-V9: a queued input joined the transcript, right before the model call of `step` (whose `step.start` follows). */
export interface InputAppliedEvent extends AgentEventBase<'input.applied'> {
  id: string;
  step: number;
}

/**
 * An input, output or tool guardrail blocked (LOU-X4).
 * `run.done { finishReason: 'guardrail' }` follows (or, with
 * `onTripped: 'throw'`, `error` and `run.done { finishReason: 'error' }`).
 */
export interface GuardrailTrippedEvent extends AgentEventBase<'guardrail.tripped'>, GuardrailTrip {}

/** A guardrail rewrote the input, the output (before its `text.done`) or a tool call's arguments (LOU-X4). */
export interface GuardrailRewroteEvent extends AgentEventBase<'guardrail.rewrote'>, GuardrailTrip {}

/**
 * LOU-W9.2: a checkpointed or approval-paused run is being continued by an
 * agent that differs from the one that saved it, and `onAgentDrift` is
 * `'warn'` (the default). The run continues; with `'error'` it is refused
 * with `LOUSHO_AGENT_DRIFT` instead and this event is not emitted.
 */
export interface AgentDriftEvent extends AgentEventBase<'agent.drift'>, AgentDrift {}

/**
 * N6: the run handed the conversation to another agent (`createAgent({ handoffs })`):
 * after the handoff call's `tool.start` / `tool.done`, before the target's
 * first `step.start`. From here on the run's steps are the target's. See docs/handoffs.md.
 */
export interface HandoffEvent extends AgentEventBase<'handoff'> {
  /** The agent that handed off. */
  from: string;
  /** The agent that takes over (`result.agentName` unless it hands on). */
  to: string;
  /** The handoff tool call. */
  toolCallId: string;
}

/**
 * Last event of every run, emitted exactly once - also for aborted, failed
 * and awaiting-approval runs.
 */
export interface RunDoneEvent extends AgentEventBase<'run.done'> {
  /** `ExecutionResult.finishReason`, or `'error'` when the run failed. */
  finishReason: ExecutionFinishReason;
  /** `ExecutionResult.text` (`''` when the run failed). */
  text: string;
  /** Total tokens of the run; absent when the run failed. */
  usage?: AgentEventUsage;
  /** LOU-V4: `ExecutionResult.object` (the validated `output`), JSON-encoded; absent when there is none. */
  object?: unknown;
}

/**
 * Every event `agent.stream()` yields, discriminated by `type`.
 *
 * @example
 * ```ts
 * for await (const event of agent.stream('Weather in Paris?')) {
 *   if (event.type === 'text.delta') process.stdout.write(event.text);
 *   if (event.type === 'tool.start') console.log(`calling ${event.toolName}`, event.args);
 * }
 * ```
 */
export type AgentEvent =
  | RunStartEvent
  | StepStartEvent
  | TextDeltaEvent
  | ObjectDeltaEvent
  | TextDoneEvent
  | ReasoningStartEvent
  | ReasoningDeltaEvent
  | ReasoningDoneEvent
  | ToolStartEvent
  | ToolResumeEvent
  | ToolPartialEvent
  | ToolDoneEvent
  | TodoUpdatedEvent
  | ToolErrorEvent
  | ApprovalRequestedEvent
  | PermissionDecisionEvent
  | StepDoneEvent
  | AgentErrorEvent
  | ProviderRetryEvent
  | ProviderFallbackEvent
  | CompactionStartEvent
  | CompactionDoneEvent
  | ContextClearedEvent
  | BudgetExceededEvent
  | InputQueuedEvent
  | InputSteeredEvent
  | InputAppliedEvent
  | GuardrailTrippedEvent
  | GuardrailRewroteEvent
  | AgentDriftEvent
  | HandoffEvent
  | RunDoneEvent;

/** The `type` of an {@link AgentEvent}. */
export type AgentEventType = AgentEvent['type'];

/**
 * The event with the given `type`.
 *
 * @example
 * ```ts
 * const onTool = (e: AgentEventOf<'tool.done'>) => console.log(e.toolName, e.durationMs);
 * ```
 */
export type AgentEventOf<TType extends AgentEventType> = Extract<AgentEvent, { type: TType }>;

/** An event without the fields the run fills in (`runId`, `seq`, `timestamp`, `v`). */
export type AgentEventPayload = {
  [K in AgentEventType]: Omit<AgentEventOf<K>, keyof AgentEventBase<string>> & { type: K };
}[AgentEventType];

/** Every event type; typed as a `Record` so the compiler rejects a missing or extra one (the list once lacked `agent.drift`). */
const EVENT_TYPE_MAP: Record<AgentEventType, true> = {
  'run.start': true,
  'step.start': true,
  'text.delta': true,
  'object.delta': true,
  'text.done': true,
  'reasoning.start': true,
  'reasoning.delta': true,
  'reasoning.done': true,
  'tool.start': true,
  'tool.resume': true,
  'tool.partial': true,
  'tool.done': true,
  'todo.updated': true,
  'tool.error': true,
  'approval.requested': true,
  'permission.decision': true,
  'step.done': true,
  'error': true,
  'provider.retry': true,
  'provider.fallback': true,
  'compaction.start': true,
  'compaction.done': true,
  'context.cleared': true,
  'budget.exceeded': true,
  'input.queued': true,
  'input.steered': true,
  'input.applied': true,
  'guardrail.tripped': true,
  'guardrail.rewrote': true,
  'agent.drift': true,
  handoff: true,
  'run.done': true,
};

const EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(EVENT_TYPE_MAP));

/**
 * Whether `value` looks like an {@link AgentEvent} of this schema version -
 * for a client parsing events received over SSE/WebSocket.
 *
 * @example
 * ```ts
 * const data: unknown = JSON.parse('{"type":"run.start"}');
 * if (isAgentEvent(data) && data.type === 'text.delta') console.log(data.text);
 * ```
 */
export function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Partial<AgentEventBase<string>>;
  return (
    event.v === AGENT_EVENT_SCHEMA_VERSION &&
    typeof event.type === 'string' &&
    EVENT_TYPES.has(event.type) &&
    typeof event.seq === 'number'
  );
}

/** `tool.start`, `tool.resume`, `tool.partial`, `tool.done` or `tool.error` - they all carry `toolCallId` and `toolName`. */
export function isToolEvent(event: AgentEvent): event is ToolStartEvent | ToolResumeEvent | ToolPartialEvent | ToolDoneEvent | ToolErrorEvent {
  return event.type.startsWith('tool.');
}

/** `text.delta` or `text.done` - both carry `text`. */
export function isTextEvent(event: AgentEvent): event is TextDeltaEvent | TextDoneEvent {
  return event.type.startsWith('text.');
}

/** `step.start` or `step.done` - both carry `step`. */
export function isStepEvent(event: AgentEvent): event is StepStartEvent | StepDoneEvent {
  return event.type.startsWith('step.');
}
