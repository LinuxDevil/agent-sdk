/**
 * LOU-P3: `loushoAgent()` for Svelte, a store over an agent's typed event
 * stream. Same state and actions as the React hook and the Vue composable;
 * the logic lives in the framework-neutral reducer and run logic (src/ui).
 * The Svelte store contract is just `subscribe(run) => unsubscribe`, so it is
 * implemented by hand and this entry imports nothing from `svelte`.
 */

import {
  createAgentRunner,
  initialAgentUIState,
  reduceAgentEvents,
  type AgentCommands,
  type AgentUIState,
  type LoushoAgentOptions,
  type LoushoAgentSource,
} from '../ui';

export type { LocalAgentSource, LoushoAgentSource, RemoteAgentSource } from '../ui';
export type LoushoAgentStoreOptions = LoushoAgentOptions;

/** A readable Svelte store (works with `$agent` in Svelte 4 and 5) holding the chat state, plus the actions. */
export type LoushoAgentStore = {
  /** Calls `run` with the current state, then on every change; returns the unsubscribe function. */
  subscribe(run: (state: AgentUIState) => void): () => void;
} & AgentCommands & {
    /** Aborts the run, forgets the in-process session and clears the chat. */
    reset(): void;
  };

/**
 * Chat UI state for an agent as a Svelte store: `messages` stream in as the
 * run's events arrive, `status` drives the composer, and a paused tool call
 * shows up as `pendingApproval` until `approve()` or `reject()`. The run in
 * flight is aborted by `stop()` and when the last subscriber unsubscribes
 * (a component using `$agent` is destroyed). See docs/svelte.md.
 *
 * @example
 * ```ts
 * const agent = loushoAgent({ url: '/api/agent' });
 * agent.subscribe(({ messages, status }) => console.log(status, messages.length));
 * ```
 */
export function loushoAgent(source: LoushoAgentSource, options: LoushoAgentStoreOptions = {}): LoushoAgentStore {
  let state = initialAgentUIState;
  const subscribers = new Set<(state: AgentUIState) => void>();
  const runner = createAgentRunner({
    source: () => source,
    options: () => options,
    state: () => state,
    dispatch: (action) => {
      const next = reduceAgentEvents(state, action);
      if (next === state) return;
      state = next;
      for (const run of [...subscribers]) run(state);
    },
  });

  return {
    ...runner,
    subscribe(run) {
      subscribers.add(run);
      run(state);
      return () => {
        subscribers.delete(run);
        if (subscribers.size === 0) runner.stop();
      };
    },
  };
}
