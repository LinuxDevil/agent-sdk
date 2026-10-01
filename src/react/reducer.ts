/**
 * LOU-D15: the framework-neutral state behind `useLoushyAgent()`: a pure
 * reducer from the typed {@link AgentEvent} stream (docs/streaming.md), plus
 * a few local actions, to chat UI state. A UI binding (React here, Vue or
 * Svelte later) only holds this state and dispatches into it.
 */

import type { AgentEvent, AgentEventError, AgentEventUsage } from '../execution/agentEvents';
import type { ApprovalKind, ApprovalQuestion } from '../execution/ApprovalGate';
import type { ContentPart } from '../providers/llm';
import { textOf } from '../providers/content';

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
  lastEvent: AgentEvent | null;
}

/** Local actions, besides the events themselves. */
export type AgentUIAction =
  /** `input` may be multimodal parts (LOU-V11); the bubble shows their text. */
  | { type: 'ui.send'; input: string | ContentPart[] }
  | { type: 'ui.decide'; approved: boolean }
  | { type: 'ui.resumed'; outcome: ApprovalOutcome }
  | { type: 'ui.stopped' }
  | { type: 'ui.error'; error: AgentEventError };

export const initialAgentUIState: AgentUIState = {
  messages: [],
  status: 'idle',
  pendingApproval: null,
  error: null,
  usage: null,
  lastEvent: null,
};

function settledStatus(finishReason: string): AgentUIStatus {
  if (finishReason === 'awaiting-approval') return 'awaiting-approval';
  return finishReason === 'error' ? 'error' : 'idle';
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

/** The paused call of an `approval.requested` event, with its question when it has one (LOU-X9). */
function pendingOf(event: Extract<AgentEvent, { type: 'approval.requested' }>): UIPendingApproval {
  const { approvalId: id, toolCallId, toolName, args, kind, question } = event;
  return { id, toolCallId, toolName, args, ...(kind && { kind }), ...(question && { question }) };
}

function pause(state: AgentUIState, approval: UIPendingApproval): AgentUIState {
  const { toolCallId: id, toolName: name, args } = approval;
  const messages = patchTool(state.messages, id, { status: 'awaiting-approval' }, { id, name, args, status: 'running' });
  return { ...state, messages, status: 'awaiting-approval', pendingApproval: approval };
}

function resumed(state: AgentUIState, { text, finishReason, usage, approval }: ApprovalOutcome): AgentUIState {
  const messages = onAssistant(state.messages, (message) => ({
    ...message,
    text: message.text && text ? `${message.text}\n\n${text}` : message.text || text,
    toolCalls: message.toolCalls.map((call) => (call.status === 'running' ? { ...call, status: 'done' } : call)),
  }));
  const next = { ...state, messages, status: settledStatus(finishReason), usage: usage ?? state.usage };
  return approval ? pause(next, approval) : next;
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
  switch (event.type) {
    case 'ui.send': {
      const user: UIMessage = { id: `m${state.messages.length}`, role: 'user', text: textOf(event.input), toolCalls: [] };
      const messages = onAssistant([...state.messages, user], (message) => message);
      return { ...state, messages, status: 'streaming', error: null, pendingApproval: null };
    }
    case 'ui.decide': {
      const id = state.pendingApproval?.toolCallId ?? '';
      const messages = patchTool(state.messages, id, { status: event.approved ? 'running' : 'rejected' });
      return { ...state, messages, status: 'streaming', pendingApproval: null };
    }
    case 'ui.resumed':
      return resumed(state, event.outcome);
    case 'ui.stopped':
      return state.status === 'streaming' ? { ...state, status: 'idle' } : state;
    case 'ui.error':
      return { ...state, status: 'error', error: event.error, pendingApproval: null };
  }
  const next = { ...state, lastEvent: event };
  if (event.subagent && event.type !== 'approval.requested') return next;
  switch (event.type) {
    case 'text.delta':
      return { ...next, messages: onAssistant(state.messages, (m) => ({ ...m, text: m.text + event.text })) };
    case 'tool.start': {
      const call: UIToolCall = { id: event.toolCallId, name: event.toolName, args: event.args, status: 'running' };
      return { ...next, messages: patchTool(state.messages, call.id, {}, call) };
    }
    case 'tool.done':
      return { ...next, messages: patchTool(state.messages, event.toolCallId, { status: 'done', result: event.result }) };
    case 'tool.error':
      return { ...next, messages: patchTool(state.messages, event.toolCallId, { status: 'error', error: event.error }) };
    case 'approval.requested':
      return pause(next, pendingOf(event));
    case 'error':
      return { ...next, error: event.error };
    case 'run.done':
      return { ...next, status: settledStatus(event.finishReason), usage: event.usage ?? state.usage };
    default:
      return next;
  }
}
