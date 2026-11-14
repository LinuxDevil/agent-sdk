/**
 * Route-driven composer focus (AA19): mounted inside `AuthorChatProvider`,
 * it keeps the Author's focus chip on the agent on screen - navigating to
 * `/agents/:id/*` sets `{ mode: 'edit', agentId }` unless the user cleared the
 * chip in this chat (`authorFocusCleared`, reset by the next new chat). Other
 * routes leave the focus alone. Focus changes never start a turn; they ride
 * on the next `chat.send`'s `focus` field.
 */
import { useEffect, useRef } from 'react';
import { useRoute } from '../router/useRoute';
import { useAuthorChat } from './AuthorChatContext';
import { authorFocusCleared } from './authorEntry';
import { agentRouteId } from '../screens/agents/agentRoute';

/** The agent id a path names (every agents URL shape, workspace-scoped included), else undefined. */
function agentIdOfPath(path: string): string | undefined {
  return agentRouteId(path);
}

/**
 * Applies route focus on every route change (and once on mount, so a reload
 * straight onto an agent page lands with the right chip). Reads the latest
 * chat through a ref so the effect keys on the path alone - dispatching
 * `focus.set` must not re-arm itself.
 */
export function AuthorRouteFocus(): null {
  const chat = useAuthorChat();
  const { path } = useRoute();
  const chatRef = useRef(chat);
  chatRef.current = chat;

  useEffect(() => {
    const agentId = agentIdOfPath(path);
    if (agentId === undefined || authorFocusCleared()) return;
    const focus = chatRef.current.state.focus;
    if (focus.mode === 'edit' && focus.agentId === agentId) return;
    chatRef.current.setFocus({ mode: 'edit', agentId });
  }, [path]);

  return null;
}
