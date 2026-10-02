/** `useTodos()`: the agent's todo list as a view with counts, the current item and progress. */

import { useMemo } from 'react';
import { todoView, type TodoView } from '../ui';
import type { UseLoushoAgentResult } from './useLoushoAgent';

/**
 * The todo list the agent keeps with the built-in todo tools (`todo.updated`
 * events), derived from the same run `useLoushoAgent()` drives, so no second
 * connection is needed. Memoized on `agent.todos`. See docs/react.md.
 *
 * @example
 * ```ts
 * const agent = useLoushoAgent({ url: '/api/agent' });
 * const { todos, counts, current, progress } = useTodos(agent);
 * ```
 */
export function useTodos(agent: Pick<UseLoushoAgentResult, 'todos'>): TodoView {
  const { todos } = agent;
  return useMemo(() => todoView(todos), [todos]);
}
