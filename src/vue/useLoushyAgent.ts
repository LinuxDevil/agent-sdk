/**
 * LOU-P2: `useLoushyAgent()` for Vue 3, a composable over an agent's typed
 * event stream. Same state and actions as the React hook; the state logic
 * lives in the framework-neutral reducer and run logic (src/ui), this file
 * only holds the state in a `shallowRef`.
 */

import { computed, getCurrentScope, onScopeDispose, shallowRef, unref, type ComputedRef, type Ref } from 'vue';
import {
  createAgentRunner,
  initialAgentUIState,
  reduceAgentEvents,
  type AgentCommands,
  type AgentUIState,
  type LoushyAgentOptions,
  type LoushyAgentSource,
} from '../ui';

export type { LocalAgentSource, LoushyAgentSource, RemoteAgentSource } from '../ui';
export type UseLoushyAgentOptions = LoushyAgentOptions;

/** A value, or a ref to it (read when a turn starts, so a changed `url` or `agent` applies to the next turn). */
type MaybeRef<T> = T | Ref<T>;

export type UseLoushyAgentResult = {
  /** Each field of the React hook's state, as a read-only ref. */
  [K in keyof AgentUIState]: ComputedRef<AgentUIState[K]>;
} & AgentCommands & {
    /** Aborts the run, forgets the in-process session and clears the chat. */
    reset(): void;
  };

/**
 * Chat UI state for an agent: `messages` stream in as the run's events
 * arrive, `status` drives the composer, and a paused tool call shows up as
 * `pendingApproval` until `approve()` or `reject()`. Disposing the owning
 * scope (component unmount, `effectScope().stop()`) aborts the run in flight.
 * See docs/vue.md.
 *
 * @example
 * ```ts
 * const { messages, status, send } = useLoushyAgent({ url: '/api/agent' });
 * ```
 */
export function useLoushyAgent(source: MaybeRef<LoushyAgentSource>, options: MaybeRef<UseLoushyAgentOptions> = {}): UseLoushyAgentResult {
  const state = shallowRef<AgentUIState>(initialAgentUIState);
  const runner = createAgentRunner({
    source: () => unref(source),
    options: () => unref(options),
    state: () => state.value,
    dispatch: (action) => {
      state.value = reduceAgentEvents(state.value, action);
    },
  });
  if (getCurrentScope()) onScopeDispose(runner.stop);

  const field = <K extends keyof AgentUIState>(key: K) => computed(() => state.value[key]);
  return {
    messages: field('messages'),
    status: field('status'),
    pendingApproval: field('pendingApproval'),
    error: field('error'),
    usage: field('usage'),
    lastEvent: field('lastEvent'),
    ...runner,
  };
}
