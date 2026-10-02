/**
 * The framework-neutral view of an agent's todo list (`todo.updated` events,
 * docs/stream-events.md) that `useTodos()` (React, Vue) and `loushoTodos()`
 * (Svelte) expose.
 */

import type { Todo } from '../tools/built-in/todo';

/** A todo list with its counts, the item being worked on and the share done. */
export interface TodoView {
  todos: readonly Todo[];
  counts: { pending: number; in_progress: number; completed: number; total: number };
  /** The `in_progress` item, else the first `pending` one; `undefined` when nothing is left. */
  current: Todo | undefined;
  /** `completed / total`, from 0 to 1 (0 for an empty list). */
  progress: number;
}

/**
 * Derives counts, the current item and the progress from a todo list.
 *
 * @example
 * ```ts
 * const { counts, current, progress } = todoView(state.todos);
 * ```
 */
export function todoView(todos: readonly Todo[]): TodoView {
  const counts = { pending: 0, in_progress: 0, completed: 0, total: todos.length };
  for (const todo of todos) counts[todo.status] += 1;
  const current = todos.find((todo) => todo.status === 'in_progress') ?? todos.find((todo) => todo.status === 'pending');
  return { todos, counts, current, progress: counts.total === 0 ? 0 : counts.completed / counts.total };
}
