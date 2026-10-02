/** `useTodos()` for Vue: the agent's todo list as refs with counts, the current item and progress. */

import { computed, type ComputedRef, type Ref } from 'vue';
import type { Todo } from '../tools/built-in/todo';
import { todoView, type TodoView } from '../ui';

/**
 * The todo list the agent keeps with the built-in todo tools (`todo.updated`
 * events), as one read-only ref per {@link TodoView} field, derived from the
 * same run `useLoushoAgent()` drives. See docs/vue.md.
 *
 * @example
 * ```ts
 * const agent = useLoushoAgent({ url: '/api/agent' });
 * const { todos, counts, current, progress } = useTodos(agent);
 * ```
 */
export function useTodos(agent: { todos: Ref<readonly Todo[]> | ComputedRef<readonly Todo[]> }): { [K in keyof TodoView]: ComputedRef<TodoView[K]> } {
  const view = computed(() => todoView(agent.todos.value));
  return {
    todos: computed(() => view.value.todos),
    counts: computed(() => view.value.counts),
    current: computed(() => view.value.current),
    progress: computed(() => view.value.progress),
  };
}
