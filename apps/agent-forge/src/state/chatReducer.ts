/**
 * P1/P2: pure state-update logic for the live chat transcript, applied to
 * every `{type:'chat'}` WS push (see AppState.tsx's subscribe() handler and
 * runtimeClient.ts's `ChatStatePayload`). Kept separate and pure (same
 * pattern as logReducer.ts/spanReducer.ts) so it's independently testable
 * without spinning up the WS client or React state.
 *
 * The server is the single source of truth for the live session (it always
 * sends the FULL transcript for whatever session is currently live, see
 * runRegistry.ts's emitChat()/chatState()) - so this isn't really
 * "merging" deltas, just adopting the latest snapshot, with one guard: an
 * out-of-order WS frame for the SAME session that has fewer messages than
 * what's already shown is dropped rather than regressing the UI (WS
 * delivery order isn't guaranteed to match send order under reconnects).
 * A payload for a DIFFERENT session id (e.g. the app just switched agents,
 * or the user started a new chat) always replaces state outright, since
 * that's a genuinely different conversation, not a stale duplicate.
 */
import type { ChatStatePayload } from '../../shared/wireTypes';

export interface ChatState {
  sessionId: string | undefined;
  messages: ChatStatePayload['messages'];
}

export function emptyChatState(): ChatState {
  return { sessionId: undefined, messages: [] };
}

export function applyChatState(current: ChatState, incoming: ChatStatePayload): ChatState {
  if (current.sessionId === incoming.sessionId && incoming.messages.length < current.messages.length) {
    return current;
  }
  return { sessionId: incoming.sessionId, messages: incoming.messages };
}
