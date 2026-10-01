/**
 * LOU-D15: `useLoushyAgent()`, a React hook over an agent's typed event
 * stream. The state logic lives in the framework-neutral reducer and run
 * logic (src/ui); this file only holds the state in `useReducer`.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
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

export interface UseLoushyAgentResult extends AgentUIState, AgentCommands {}

/**
 * Chat UI state for an agent: `messages` stream in as the run's events
 * arrive, `status` drives the composer, and a paused tool call shows up as
 * `pendingApproval` until `approve()` or `reject()`. Unmounting aborts the
 * run in flight. See docs/react.md.
 *
 * @example
 * ```ts
 * const { messages, status, send } = useLoushyAgent({ url: '/api/agent' });
 * ```
 */
export function useLoushyAgent(source: LoushyAgentSource, options: UseLoushyAgentOptions = {}): UseLoushyAgentResult {
  const [state, dispatch] = useReducer(reduceAgentEvents, initialAgentUIState);
  const latest = useRef({ source, options, state });
  latest.current = { source, options, state };
  const [runner] = useState(() =>
    createAgentRunner({
      source: () => latest.current.source,
      options: () => latest.current.options,
      state: () => latest.current.state,
      dispatch,
    })
  );

  useEffect(() => runner.stop, [runner]);

  const { send, stop, approve, reject, answer } = runner;
  return { ...state, send, stop, approve, reject, answer };
}
