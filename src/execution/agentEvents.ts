/**
 * LOU-V2: the typed, versioned event schema of `agent.stream()` /
 * `AgentExecutor.stream()`. Every event is a plain JSON value (no `Error`
 * instances, no functions, no `undefined` fields), so it can be sent over
 * SSE or a WebSocket unchanged and parsed back to the same object.
 *
 * See docs/streaming.md for the full table - this file is the public schema.
 */

import type { ExecutionFinishReason } from './AgentExecutor';
import type { SubagentInfo } from './hooks';
import type { CompactedProviderErrorCategory } from './errors';
import type { PermissionDecisionEntry } from './permissions';
import type { ApprovalKind, ApprovalQuestion } from './ApprovalGate';
import type { BudgetExceeded } from './budget';
import type { GuardrailTrip } from './ioGuardrails';

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
}

/** A JSON-safe error: the `name` and `message` of the original error. */
export interface AgentEventError {
  name: string;
  message: string;
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
   * LOU-Y1: set on events of a sub-agent's run (started by the `task` tool or
   * a `createDelegateTool()` tool): which sub-agent, and the tool call of this
   * run that started it. Absent on the top-level run's own events, and never
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

/** The complete text of the current step (the concatenation of its `text.delta`s). */
export interface TextDoneEvent extends AgentEventBase<'text.done'> {
  text: string;
}

/** A tool call starts. Emitted in the model's call order. */
export interface ToolStartEvent extends AgentEventBase<'tool.start'> {
  toolCallId: string;
  toolName: string;
  /** The arguments the model sent, parsed from JSON (`{}` when they are not valid JSON). */
  args: Record<string, unknown>;
}

/** A tool call returned. Emitted in completion order. */
export interface ToolDoneEvent extends AgentEventBase<'tool.done'> {
  toolCallId: string;
  toolName: string;
  /** The tool's result as it would be JSON-encoded (`undefined` becomes `null`). */
  result: unknown;
  /** Milliseconds since this call's `tool.start`. */
  durationMs: number;
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
  /** LOU-X9: `'question'` when an `ask_question` call waits for the user's answer; absent for a tool approval. */
  kind?: ApprovalKind;
  /** LOU-X9: the question's text and options, when `kind` is `'question'`. */
  question?: ApprovalQuestion;
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
   * or `'awaiting-approval'`, `'aborted'` or `'error'` when the step ended that way.
   */
  finishReason: ExecutionFinishReason;
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
}

/**
 * A compaction ended (LOU-W3.2). `tokensAfter` equals `tokensBefore` when
 * nothing could be compacted. `error` is set when the strategy failed or fell
 * back (e.g. the summarizer failed and only tool results were pruned); the
 * run continues either way.
 */
export interface CompactionDoneEvent extends AgentEventBase<'compaction.done'> {
  strategy: string;
  tokensBefore: number;
  tokensAfter: number;
  /** `toolCallId`s whose results were replaced by a marker. */
  prunedToolCallIds: string[];
  /** `true` when old turns were replaced by a model-written summary (the text is not sent). */
  summary?: boolean;
  error?: { message: string };
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
  | TextDoneEvent
  | ToolStartEvent
  | ToolDoneEvent
  | ToolErrorEvent
  | ApprovalRequestedEvent
  | PermissionDecisionEvent
  | StepDoneEvent
  | AgentErrorEvent
  | ProviderRetryEvent
  | ProviderFallbackEvent
  | CompactionStartEvent
  | CompactionDoneEvent
  | BudgetExceededEvent
  | InputQueuedEvent
  | InputAppliedEvent
  | GuardrailTrippedEvent
  | GuardrailRewroteEvent
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

const EVENT_TYPES: ReadonlySet<string> = new Set<AgentEventType>([
  'run.start',
  'step.start',
  'text.delta',
  'text.done',
  'tool.start',
  'tool.done',
  'tool.error',
  'approval.requested',
  'permission.decision',
  'step.done',
  'error',
  'provider.retry',
  'provider.fallback',
  'compaction.start',
  'compaction.done',
  'budget.exceeded',
  'input.queued',
  'input.applied',
  'guardrail.tripped',
  'guardrail.rewrote',
  'run.done',
]);

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

/** `tool.start`, `tool.done` or `tool.error` - they all carry `toolCallId` and `toolName`. */
export function isToolEvent(event: AgentEvent): event is ToolStartEvent | ToolDoneEvent | ToolErrorEvent {
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
