/** `loushoTodos()` for Svelte: the agent's todo list as a store of counts, the current item and progress. */

import { todoView, type TodoView } from '../ui';
import type { LoushoAgentStore } from './loushoAgent';

/**
 * A readable store of the todo list the agent keeps with the built-in todo
 * tools (`todo.updated` events), derived from the same `loushoAgent()` store
 * (no second connection). It notifies only when the list changes. See docs/svelte.md.
 *
 * @example
 * ```ts
 * const agent = loushoAgent({ url: '/api/agent' });
 * const plan = loushoTodos(agent); // `$plan.current`, `$plan.progress`
 * ```
 */
export function loushoTodos(agent: LoushoAgentStore): { subscribe(run: (view: TodoView) => void): () => void } {
  return {
    subscribe(run) {
      let last: TodoView | undefined;
      return agent.subscribe((state) => {
        if (last && last.todos === state.todos) return;
        last = todoView(state.todos);
        run(last);
      });
    },
  };
}
