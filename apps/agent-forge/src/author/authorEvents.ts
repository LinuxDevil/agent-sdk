/**
 * The tiny app-wide signal that an agent changed because the Author
 * saved it. The chat provider fires it when a save lands - the card's
 * Apply button (`save.succeeded`) or a live `tool.result` of
 * `saveAgent`/`saveAgentUpdate`/`setAgentEnabled` - and AA18's canvas
 * sync subscribes to drop its cached specs. It exists so the chat code
 * never imports canvas code: one direction, one function, no React.
 *
 * Not fired for replayed stream events (a `chat.resume` replay can
 * surface an old save's `tool.result` again - the provider suppresses
 * the emitter while a reattach pass runs; see AuthorChatContext).
 */

/**
 * What an Author-driven save changed: `'spec'` rewrote the agent's spec
 * (saveAgent/saveAgentUpdate - the canvas reloads), `'meta'` only flipped
 * a meta flag like `enabled` (setAgentEnabled - the canvas is untouched).
 */
export type AgentSavedChange = 'spec' | 'meta';

/** A listener that drops cached state for `agentId`. */
export type AgentSavedListener = (agentId: string, change?: AgentSavedChange) => void;

const listeners = new Set<AgentSavedListener>();

/**
 * Subscribes `listener` to Author-driven saves; returns the unsubscribe.
 * AA18's canvas-sync hook registers once per mounted canvas.
 */
export function onAgentSaved(listener: AgentSavedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fires every registered listener for `agentId`. Called by
 * `AuthorChatContext` only - a listener that throws is reported and
 * skipped so one bad subscriber can't break the chat.
 */
export function fireAgentSaved(agentId: string, change: AgentSavedChange = 'spec'): void {
  for (const listener of listeners) {
    try {
      listener(agentId, change);
    } catch {
      // Listener faults stay with the listener (see the JSDoc above).
    }
  }
}

/** A listener that navigates to `path` (the `openPage` tool's client-side half). */
export type OpenPageListener = (path: string) => void;

const openPageListeners = new Set<OpenPageListener>();

/**
 * Subscribes `listener` to the Author's `openPage` navigations; returns
 * the unsubscribe. The panel registers its router's `navigate` so a
 * live `openPage` `tool.result` can move the app - replayed results
 * never navigate (the provider suppresses firing during reattach).
 */
export function onOpenPage(listener: OpenPageListener): () => void {
  openPageListeners.add(listener);
  return () => {
    openPageListeners.delete(listener);
  };
}

/**
 * Fires every `onOpenPage` listener for `path`. Called by
 * `AuthorChatContext` only, for live `openPage` results with `ok: true`.
 */
export function fireOpenPage(path: string): void {
  for (const listener of openPageListeners) {
    try {
      listener(path);
    } catch {
      // Same rule as saves: a listener fault never reaches the chat.
    }
  }
}
