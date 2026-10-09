/**
 * LOU-D15: the framework-neutral state behind `useLoushoAgent()`: a pure
 * reducer from the typed {@link AgentEvent} stream (docs/stream-events.md), plus
 * a few local actions, to chat UI state. A UI binding (React, Vue, Svelte
 * later) only holds this state and dispatches into it.
 */

import type { AgentEvent, AgentEventError, AgentEventUsage } from '../execution/agentEvents';
import { describeInput, type AgentInput } from '../providers/content';
import type { Todo } from '../tools/built-in/todo';
import type { ApprovalKind, ApprovalQuestion, ApprovalSignIn } from '../execution/ApprovalGate';

/** Where a tool call stands: running, paused for approval, or finished. */
export type UIToolCallStatus = 'running' | 'awaiting-approval' | 'done' | 'error' | 'rejected';

/** A tool call of an assistant message. */
export interface UIToolCall {
  /** The `toolCallId` of its events. */
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: UIToolCallStatus;
  /** The tool's result, from `tool.done`. */
  result?: unknown;
  /**
   * N13b: the latest snapshot of a running generator tool's output, from
   * `tool.partial`. Removed when the call settles (`tool.done` / `tool.error`),
   * pauses, or starts again.
   */
  partial?: unknown;
  /** Why it failed, from `tool.error`. */
  error?: AgentEventError;
}

/** One chat bubble: the user's input, or the agent's text and tool calls for that turn. */
export interface UIMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Tool calls in start order (always empty for user messages). */
  toolCalls: UIToolCall[];
  /** LOU-V13: the model's reasoning text for this turn (`reasoning.delta`s), when it streamed any. */
  reasoning?: string;
  /** Eve CORE-F9: the run's `finishReason` (`run.done`), set on the assistant message it ended; absent while it runs. */
  finishReason?: string;
  /** Eve CORE-F9: the run's validated typed `output` (`run.done.object`), when the run had one. */
  object?: unknown;
  /** @internal Eve CORE-F9: a new step started after this text, so the next `text.delta` opens a new paragraph. */
  stepBreak?: boolean;
}

/** `streaming` while a run (or an approval's continuation) is in flight. */
export type AgentUIStatus = 'idle' | 'streaming' | 'awaiting-approval' | 'error';

/** The tool call a run paused on, from `approval.requested`. */
export interface UIPendingApproval {
  id: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** LOU-X9: `'question'` when the agent asked the user something (`ask_question`); answer it with `answer(text)`. */
  kind?: ApprovalKind;
  /** LOU-X9: the question's text and options, when `kind` is `'question'`. */
  question?: ApprovalQuestion;
  /**
   * N9b: where to sign in, when `kind` is `'sign-in'`: show `signIn.url`, and
   * call `approve()` once the user signed in ("I've signed in"), `reject()` to cancel.
   */
  signIn?: ApprovalSignIn;
  /** TTL: when the pause stops being decidable (ISO-8601); a later decision denies the call. Absent: never. */
  expiresAt?: string;
}

/** How a run continued after an approval decision (built from `agent.approvals.resolve()`'s result). */
export interface ApprovalOutcome {
  text: string;
  finishReason: string;
  usage?: AgentEventUsage;
  /** Set when the continued run paused on another approval. */
  approval?: UIPendingApproval | null;
}

export interface AgentUIState {
  messages: UIMessage[];
  status: AgentUIStatus;
  pendingApproval: UIPendingApproval | null;
  /** The last `error` event, or a transport failure. */
  error: AgentEventError | null;
  /** Token usage of the last finished run (`run.done`). */
  usage: AgentEventUsage | null;
  /**
   * Eve CORE-F9: how the last run ended (`run.done`): `'stop'`, or `'max-steps'`,
   * `'output-invalid'`, `'budget-exceeded'`, `'guardrail'`, `'aborted'`, ...
   * `null` before the first run ends. The first four also set `status: 'error'`
   * and `error`, so they are not mistaken for success.
   */
  finishReason: string | null;
  /** The agent's todo list, from the last top-level `todo.updated`; carries across turns and is cleared by `reset()`. */
  todos: readonly Todo[];
  /**
   * Eve CORE-F13: for an agent with an `output` schema, the reply parsed so
   * far (the last top-level `object.delta`), then the validated object of
   * `run.done`. Best-effort and not validated while streaming; `null` until
   * the first `object.delta` of a run (and for agents without `output`).
   */
  partialObject: unknown;
  lastEvent: AgentEvent | null;
}

/** Local actions, besides the events themselves. */
export type AgentUIAction =
  /** `input` may be multimodal (LOU-V12); the bubble shows its text and an `[image]` / `[file]` marker per other part. */
  | { type: 'ui.send'; input: AgentInput }
  | { type: 'ui.decide'; approved: boolean }
  | { type: 'ui.resumed'; outcome: ApprovalOutcome }
  | { type: 'ui.stopped' }
  /** LOU-P2: back to the empty chat. */
  | { type: 'ui.reset' }
  | { type: 'ui.error'; error: AgentEventError };

export const initialAgentUIState: AgentUIState = {
  messages: [],
  status: 'idle',
  pendingApproval: null,
  error: null,
  usage: null,
  finishReason: null,
  todos: [],
  partialObject: null,
  lastEvent: null,
};

/** Eve CORE-F9: endings that are neither a normal answer nor already an `error` event. */
const FAILED_ENDINGS: Record<string, string> = {
  'max-steps': 'The run stopped at its step limit (maxSteps) before finishing.',
  'output-invalid': 'The final reply did not match the requested output schema.',
  'budget-exceeded': 'The run stopped because it exceeded its budget (limits).',
  guardrail: 'The run was stopped by a guardrail.',
};

function settledStatus(finishReason: string): AgentUIStatus {
  if (finishReason === 'awaiting-approval') return 'awaiting-approval';
  return finishReason === 'error' || Object.hasOwn(FAILED_ENDINGS, finishReason) ? 'error' : 'idle';
}

/** Eve CORE-F9: the error to show for a non-`stop` ending, unless an `error` event already set one. */
function endingError(finishReason: string, current: AgentEventError | null): AgentEventError | null {
  if (current || !Object.hasOwn(FAILED_ENDINGS, finishReason)) return current;
  return { name: 'RunEndedError', message: FAILED_ENDINGS[finishReason] };
}

/** Applies `update` to the last assistant message, appending an empty one first if the last message is not one. */
function onAssistant(messages: UIMessage[], update: (message: UIMessage) => UIMessage): UIMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant') return [...messages.slice(0, -1), update(last)];
  return [...messages, update({ id: `m${messages.length}`, role: 'assistant', text: '', toolCalls: [] })];
}

/** Patches the tool call `id` of the last assistant message; adds `added` (patched) when it is not there. */
function patchTool(messages: UIMessage[], id: string, patch: Partial<UIToolCall>, added?: UIToolCall): UIMessage[] {
  return onAssistant(messages, (message) => {
    const known = message.toolCalls.some((call) => call.id === id);
    const toolCalls = known
      ? message.toolCalls.map((call) => (call.id === id ? { ...call, ...patch } : call))
      : added
        ? [...message.toolCalls, { ...added, ...patch }]
        : message.toolCalls;
    return { ...message, toolCalls };
  });
}

/** N13b: `call` without its `partial` snapshot. */
function withoutPartial({ partial: _partial, ...call }: UIToolCall): UIToolCall {
  return call;
}

/** N13b: patches the tool call `id` of the last assistant message and drops its `partial`. */
function settleTool(messages: UIMessage[], id: string, patch: Partial<UIToolCall>, added?: UIToolCall): UIMessage[] {
  return onAssistant(patchTool(messages, id, patch, added), (message) => ({
    ...message,
    toolCalls: message.toolCalls.map((call) => (call.id === id ? withoutPartial(call) : call)),
  }));
}

/**
 * N13b: the snapshot of a `tool.partial` on its call - only while that call
 * is running, so a snapshot that arrives after the call settled or paused
 * never replaces its state.
 */
function partialOf(messages: UIMessage[], event: Extract<AgentEvent, { type: 'tool.partial' }>): UIMessage[] {
  const last = messages[messages.length - 1];
  const running = last?.role === 'assistant' && last.toolCalls.some((call) => call.id === event.toolCallId && call.status === 'running');
  return running ? patchTool(messages, event.toolCallId, { partial: event.output }) : messages;
}

/** The paused call of an `approval.requested` event, with its question (LOU-X9) or sign-in link (N9b) when it has one. */
function pendingOf(event: Extract<AgentEvent, { type: 'approval.requested' }>): UIPendingApproval {
  const { approvalId: id, toolCallId, toolName, args, kind, question, signIn, expiresAt } = event;
  return { id, toolCallId, toolName, args, ...(kind && { kind }), ...(question && { question }), ...(signIn && { signIn }), ...(expiresAt && { expiresAt }) };
}

function pause(state: AgentUIState, approval: UIPendingApproval): AgentUIState {
  const { toolCallId: id, toolName: name, args } = approval;
  const messages = settleTool(state.messages, id, { status: 'awaiting-approval' }, { id, name, args, status: 'running' });
  return { ...state, messages, status: 'awaiting-approval', pendingApproval: approval };
}

function resumed(state: AgentUIState, { text, finishReason, usage, approval }: ApprovalOutcome): AgentUIState {
  const messages = onAssistant(state.messages, (message) => ({
    ...message,
    text: message.text && text ? `${message.text}\n\n${text}` : message.text || text,
    toolCalls: message.toolCalls.map((call) => (call.status === 'running' ? { ...withoutPartial(call), status: 'done' } : call)),
  }));
  const next = {
    ...state,
    messages,
    status: settledStatus(finishReason),
    usage: usage ?? state.usage,
    finishReason,
    error: endingError(finishReason, state.error),
  };
  return approval ? pause(next, approval) : next;
}

/**
 * Eve CORE-F9: stamps the run's `finishReason` (and typed `object`) on the
 * assistant message. A run with an `output` schema shows only its final reply:
 * the rejected attempts of an earlier step are replaced by `run.done.text`.
 */
function finishMessage(messages: UIMessage[], event: Extract<AgentEvent, { type: 'run.done' }>): UIMessage[] {
  const typed = event.object !== undefined || event.finishReason === 'output-invalid';
  return onAssistant(messages, ({ stepBreak: _stepBreak, ...m }) => ({
    ...m,
    ...(typed && event.text && { text: event.text }),
    finishReason: event.finishReason,
    ...(event.object !== undefined && { object: event.object }),
  }));
}

function isUIAction(event: AgentEvent | AgentUIAction): event is AgentUIAction {
  return event.type.startsWith('ui.');
}

/** The next state after a local action. */
function reduceAction(state: AgentUIState, event: AgentUIAction): AgentUIState {
  switch (event.type) {
    case 'ui.send': {
      const user: UIMessage = { id: `m${state.messages.length}`, role: 'user', text: describeInput(event.input), toolCalls: [] };
      const messages = onAssistant([...state.messages, user], (message) => message);
      return { ...state, messages, status: 'streaming', error: null, finishReason: null, pendingApproval: null, partialObject: null };
    }
    case 'ui.decide': {
      const id = state.pendingApproval?.toolCallId ?? '';
      const messages = patchTool(state.messages, id, { status: event.approved ? 'running' : 'rejected' });
      return { ...state, messages, status: 'streaming', pendingApproval: null };
    }
    case 'ui.resumed':
      return resumed(state, event.outcome);
    case 'ui.reset':
      return initialAgentUIState;
    case 'ui.stopped':
      return state.status === 'streaming' ? { ...state, status: 'idle' } : state;
    case 'ui.error':
      return { ...state, status: 'error', error: event.error, pendingApproval: null };
  }
}

/**
 * The next UI state after an {@link AgentEvent} or a local {@link AgentUIAction}.
 * Pure, so it works with React's `useReducer`, a Vue `ref` or a Svelte store.
 * Events of a sub-agent's run (with `subagent`) only update `lastEvent`,
 * except `approval.requested`.
 *
 * @example
 * ```ts
 * let state = reduceAgentEvents(initialAgentUIState, { type: 'ui.send', input: 'Hi' });
 * for await (const event of agent.stream('Hi')) state = reduceAgentEvents(state, event);
 * ```
 */
export function reduceAgentEvents(state: AgentUIState, event: AgentEvent | AgentUIAction): AgentUIState {
  if (isUIAction(event)) return reduceAction(state, event);
  const next = { ...state, lastEvent: event };
  if (event.subagent && event.type !== 'approval.requested') return next;
  switch (event.type) {
    case 'step.start':
      // Eve CORE-F9: a later step's text is a new paragraph, not glued to the earlier one ("weather.It is").
      return { ...next, messages: onAssistant(state.messages, (m) => (m.text ? { ...m, stepBreak: true } : m)) };
    case 'text.delta':
      return {
        ...next,
        messages: onAssistant(state.messages, ({ stepBreak, ...m }) => ({ ...m, text: stepBreak && m.text ? `${m.text}\n\n${event.text}` : m.text + event.text })),
      };
    case 'object.delta':
      return { ...next, partialObject: event.object };
    case 'reasoning.delta':
      return { ...next, messages: onAssistant(state.messages, (m) => ({ ...m, reasoning: (m.reasoning ?? '') + event.text })) };
    case 'tool.start':
    case 'tool.resume': {
      const call: UIToolCall = { id: event.toolCallId, name: event.toolName, args: event.args, status: 'running' };
      // N13b: a call that starts again (after a sign-in) drops the snapshot of its earlier attempt.
      return { ...next, messages: settleTool(state.messages, call.id, {}, call) };
    }
    case 'tool.partial':
      return { ...next, messages: partialOf(state.messages, event) };
    case 'tool.done':
      return { ...next, messages: settleTool(state.messages, event.toolCallId, { status: 'done', result: event.result }) };
    case 'tool.error':
      // A reviewer's rejection (streamed continuation, LOU-D32.2) is `rejected`, not a failure.
      return { ...next, messages: settleTool(state.messages, event.toolCallId, event.error.name === 'ToolRejectedError' ? { status: 'rejected' } : { status: 'error', error: event.error }) };
    case 'todo.updated':
      return { ...next, todos: event.todos };
    case 'approval.requested':
      return pause(next, pendingOf(event));
    case 'error':
      return { ...next, error: event.error };
    case 'run.done':
      return {
        ...next,
        messages: finishMessage(state.messages, event),
        status: settledStatus(event.finishReason),
        usage: event.usage ?? state.usage,
        finishReason: event.finishReason,
        error: endingError(event.finishReason, state.error),
        ...(event.object !== undefined && { partialObject: event.object }),
      };
    default:
      return next;
  }
}
