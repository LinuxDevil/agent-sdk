/**
 * P1: reconciles the chat transcript RunManager keeps for one agent with a
 * fresh, authoritative `Message[]` from an `ExecutionResult` (the SDK's own
 * `AgentExecutor` conversation state - see AgentExecutor.ts).
 *
 * Why reconcile instead of appending incrementally from the run's
 * AgentEvents: the `text.done`/`tool.start`/`tool.done` events are
 * already forwarded as `{type:'event'}` WS messages (driving the Logs tab
 * and the chat's typing indicator), but building the chat transcript itself
 * from that same event stream would mean reconstructing (and risking
 * drifting from) AgentExecutor's own message-building logic - exactly the
 * "invented parallel message store" the epic brief warns against. Instead,
 * once a run settles (completes OR pauses for approval - both hand back a
 * full `ExecutionResult.messages`, see runRegistry.ts's handleRunSettled),
 * this reconciles that authoritative array against what the transcript
 * already had, so the source of truth is always exactly what
 * AgentExecutor itself saw.
 *
 * Reconciliation preserves `id`/`timestamp` for messages that already
 * existed (matched from the tail backwards, since new messages are always
 * appended - the one exception being a system prompt prepended ahead of
 * everything on a conversation's very first turn, which this handles by
 * treating anything before the matched suffix as "new" too) and assigns
 * fresh ones for genuinely new messages.
 */
import { randomUUID } from 'node:crypto';
import { textOf, type Message } from '@loushy/build-ai-agent';
import type { ChatMessage } from '../shared/wireTypes';

/** The transcript keeps text only (LOU-V11 content parts are flattened with `textOf()`). */
function toChatMessage(m: Message, id: string, timestamp: string): ChatMessage {
  return { ...m, content: textOf(m), id, timestamp };
}

function sameMessage(a: ChatMessage, b: Message): boolean {
  return (
    a.role === b.role &&
    a.content === textOf(b) &&
    a.toolCallId === b.toolCallId &&
    a.toolName === b.toolName &&
    JSON.stringify(a.toolCalls ?? null) === JSON.stringify(b.toolCalls ?? null)
  );
}

/** Length of the common prefix between `prev` and `next`, treating `next`'s first `offset` entries as not part of `prev` at all. */
function prefixMatchLength(prev: ChatMessage[], next: Message[], offset: number): number {
  let matched = 0;
  while (matched < prev.length && offset + matched < next.length && sameMessage(prev[matched], next[offset + matched])) {
    matched++;
  }
  return matched;
}

export function reconcileChatMessages(
  prev: ChatMessage[],
  next: Message[],
  settledAt: string
): ChatMessage[] {
  // New messages are always APPENDED to the conversation, so `prev` is
  // normally an exact prefix of `next` (offset 0). The one exception is a
  // conversation's very first turn: `prev` there is just the optimistic
  // user message sendMessage() pushed (no system message), while `next`
  // (AgentExecutor's real messages) starts with the system prompt ahead of
  // it - a single extra leading entry (offset 1). Try both and keep
  // whichever aligns more of `prev`, rather than hard-coding which case
  // this run is in.
  const offset0 = prefixMatchLength(prev, next, 0);
  const offset1 = prefixMatchLength(prev, next, 1);
  const offset = offset1 > offset0 ? 1 : 0;
  const matched = offset === 1 ? offset1 : offset0;

  const leading: ChatMessage[] = next.slice(0, offset).map((m) => toChatMessage(m, randomUUID(), settledAt));
  const matchedPart: ChatMessage[] = prev
    .slice(0, matched)
    .map((old, idx) => toChatMessage(next[offset + idx], old.id, old.timestamp));
  const trailing: ChatMessage[] = next
    .slice(offset + matched)
    .map((m) => toChatMessage(m, randomUUID(), settledAt));
  return [...leading, ...matchedPart, ...trailing];
}
