/**
 * Durable-execution transcript helpers (LOU-U7, LOU-U8, LOU-U9): find the
 * tool calls of an interrupted model turn that still have no result, and
 * merge new input into a stored session transcript without duplicating it
 * or breaking the "tool results directly follow their tool-call turn" rule
 * every provider enforces.
 */

import type { Message, ToolCall } from '../providers';

/** A transcript split around its last model turn's unanswered tool calls. */
export interface PendingTurn {
  /** The transcript up to the last assistant turn plus its recorded results, in call order. */
  messages: Message[];
  /** Tool calls of the last assistant turn that have no result yet, in call order. */
  pendingToolCalls: ToolCall[];
  /**
   * Messages found after that turn which are not its results (e.g. a user
   * message queued while the turn was incomplete). They belong after the
   * turn's results, so they are held back until every call has one.
   */
  queuedInput: Message[];
}

function lastIndexWhere(messages: readonly Message[], test: (m: Message) => boolean): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (test(messages[i])) return i;
  }
  return -1;
}

/**
 * Splits off the unanswered tool calls of the transcript's last assistant
 * turn, moving that turn's results (in call order) directly behind it and
 * any other message found after it behind the results - held back as
 * `queuedInput` while calls are still pending. A transcript already in
 * that shape with every call answered comes back unchanged.
 */
export function splitPendingTurn(messages: Message[]): PendingTurn {
  const turnIndex = lastIndexWhere(messages, (m) => m.role === 'assistant');
  const calls = turnIndex >= 0 ? (messages[turnIndex].toolCalls ?? []) : [];
  if (calls.length === 0) {
    return { messages, pendingToolCalls: [], queuedInput: [] };
  }
  const order = new Map(calls.map((call, index) => [call.id, index]));
  const after = messages.slice(turnIndex + 1);
  const results = after.filter((m) => m.role === 'tool' && order.has(m.toolCallId ?? ''));
  const others = after.filter((m) => !results.includes(m));
  const answered = new Set(results.map((m) => m.toolCallId));
  const pendingToolCalls = calls.filter((call) => !answered.has(call.id));
  const callIndex = (m: Message) => order.get(m.toolCallId ?? '') ?? 0;
  const turn = [...messages.slice(0, turnIndex + 1), ...results.sort((a, b) => callIndex(a) - callIndex(b))];
  return pendingToolCalls.length === 0
    ? { messages: [...turn, ...others], pendingToolCalls, queuedInput: [] }
    : { messages: turn, pendingToolCalls, queuedInput: others };
}

/** `input` as messages (a string is one user message). */
export function inputMessages(input: string | Message[]): Message[] {
  return typeof input === 'string' ? [{ role: 'user', content: input }] : [...input];
}

function messageKey(m: Message): string {
  return JSON.stringify([m.role, m.content, m.toolCallId ?? null]);
}

function sharedPrefixLength(known: readonly Message[], incoming: readonly Message[]): number {
  let shared = 0;
  while (shared < known.length && shared < incoming.length && messageKey(known[shared]) === messageKey(incoming[shared])) {
    shared++;
  }
  return shared;
}

/** True for a real user turn (not a LOU-T4 `[provider-error]` note). */
function isUserTurn(m: Message): boolean {
  return m.role === 'user' && !m.content.startsWith('[provider-error]');
}

/** True when `incoming` re-sends the user turn the stored, unfinished run started from. */
function repeatsLatestUserTurn(known: readonly Message[], incoming: readonly Message[]): boolean {
  const end = lastIndexWhere(known as Message[], isUserTurn);
  if (end < 0 || incoming.length === 0 || incoming.length > end + 1) {
    return false;
  }
  const candidate = known.slice(end + 1 - incoming.length, end + 1);
  return candidate.every((m, i) => messageKey(m) === messageKey(incoming[i]));
}

/**
 * LOU-U8: the messages of `input` that are new to a stored session
 * transcript - what a session resume or continuation appends. System
 * messages in `input` are dropped (the session already has its own).
 *
 * - `input` that starts with the whole stored transcript (a caller that
 *   keeps the history itself and re-sends it) contributes only what follows.
 * - For a finished run, anything else is appended as is.
 * - For an unfinished run, `input` that re-sends the stored transcript's
 *   beginning, or the user turn the run started from, is a retry of that
 *   run and contributes nothing; a different message is appended.
 */
export function newSessionMessages(stored: readonly Message[], input: string | Message[], finished: boolean): Message[] {
  const known = stored.filter((m) => m.role !== 'system');
  const incoming = inputMessages(input).filter((m) => m.role !== 'system');
  const shared = sharedPrefixLength(known, incoming);
  if (shared === known.length || (!finished && shared > 0)) {
    return incoming.slice(shared);
  }
  if (finished || !repeatsLatestUserTurn(known, incoming)) {
    return incoming;
  }
  return [];
}
