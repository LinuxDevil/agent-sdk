import { describe, it, expect } from 'vitest';
import type { Todo } from '../tools/built-in/todo';
import { todoView } from './todos';

const todo = (id: string, status: Todo['status']): Todo => ({ id, content: id, status });

describe('todoView (N12)', () => {
  it('is empty for an empty list', () => {
    expect(todoView([])).toEqual({ todos: [], counts: { pending: 0, in_progress: 0, completed: 0, total: 0 }, current: undefined, progress: 0 });
  });

  it('counts per status, and the current item is the in_progress one', () => {
    const todos = [todo('a', 'completed'), todo('b', 'pending'), todo('c', 'in_progress')];
    const view = todoView(todos);
    expect(view.counts).toEqual({ pending: 1, in_progress: 1, completed: 1, total: 3 });
    expect(view.current).toBe(todos[2]);
    expect(view.progress).toBeCloseTo(1 / 3);
    expect(view.todos).toBe(todos);
  });

  it('falls back to the first pending item, and to undefined when all are completed', () => {
    const todos = [todo('a', 'completed'), todo('b', 'pending'), todo('c', 'pending')];
    expect(todoView(todos).current).toBe(todos[1]);
    const done = todoView([todo('a', 'completed')]);
    expect(done.current).toBeUndefined();
    expect(done.progress).toBe(1);
  });
});
