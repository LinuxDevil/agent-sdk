import { describe, it, expect, vi } from 'vitest';
import { createTodoTools, type Todo, type TodoStore } from './todo';
import { createAgent } from '../../createAgent';
import { mockModel } from '../../testing';

/** The JSON the model received as the result of tool call `n` (0-based), read from the last recorded request. */
function toolResults(model: ReturnType<typeof mockModel>): Array<Record<string, unknown>> {
  const last = model.calls[model.calls.length - 1];
  return last.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(String(m.content)));
}

describe('createTodoTools', () => {
  it('lets a run write, update and read the list, keeping ids stable', async () => {
    const todos = createTodoTools();
    const model = mockModel([
      {
        toolCalls: [
          {
            name: 'todo_write',
            args: {
              todos: [
                { content: 'Write tests', status: 'in_progress' },
                { content: 'Ship it', status: 'pending' },
              ],
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'todo_write',
            args: {
              todos: [
                { content: 'Write tests', status: 'completed' },
                { content: 'Ship it', status: 'in_progress' },
                { content: 'Celebrate', status: 'pending' },
              ],
            },
          },
          { name: 'todo_read' },
        ],
      },
      'All done.',
    ]);
    const agent = createAgent({ prompt: 'Plan then act.', provider: model, tools: todos.tools });

    const result = await agent.send('Do the thing');

    expect(result.text).toBe('All done.');
    const [, , read] = toolResults(model);
    const final = await todos.getTodos();
    expect(final.map((t) => [t.id, t.content, t.status])).toEqual([
      ['todo_1', 'Write tests', 'completed'],
      ['todo_2', 'Ship it', 'in_progress'],
      ['todo_3', 'Celebrate', 'pending'],
    ]);
    expect(read).toEqual({
      todos: final,
      counts: { pending: 1, in_progress: 1, completed: 1, total: 3 },
    });
  });

  it('assigns ids once, keeps explicit ids and avoids collisions', async () => {
    const { todoWrite, getTodos } = createTodoTools();
    const exec = todoWrite.tool.execute as (args: unknown, ctx: unknown) => Promise<unknown>;
    await exec({ todos: [{ id: 'todo_1', content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] }, {});
    expect((await getTodos()).map((t) => t.id)).toEqual(['todo_1', 'todo_2']);
    await exec({ todos: [{ content: 'b', status: 'completed' }, { content: 'c', status: 'pending' }] }, {});
    expect((await getTodos()).map((t) => t.id)).toEqual(['todo_2', 'todo_3']);
  });

  it('returns validation failures (two in_progress, duplicate ids, empty content) to the model as structured errors', async () => {
    const todos = createTodoTools();
    const model = mockModel([
      {
        toolCalls: [
          {
            name: 'todo_write',
            args: { todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }] },
          },
          { name: 'todo_write', args: { todos: [{ id: 'x', content: 'a', status: 'pending' }, { id: 'x', content: 'b', status: 'pending' }] } },
          { name: 'todo_write', args: { todos: [{ content: '  ', status: 'pending' }] } },
        ],
      },
      'gave up',
    ]);
    const agent = createAgent({ prompt: 'p', provider: model, tools: todos.tools });

    await agent.send('go');

    const [two, dup, empty] = toolResults(model);
    expect(two).toMatchObject({ error: 'ToolArgumentsValidationError', toolName: 'todo_write' });
    expect(String(two.message)).toMatch(/at most one todo may be in_progress/i);
    expect(String(dup.message)).toMatch(/unique/);
    expect(empty).toMatchObject({ error: 'ToolArgumentsValidationError' });
    expect(await todos.getTodos()).toEqual([]);
  });

  it('calls onChange with the new list after each write', async () => {
    const onChange = vi.fn();
    const todos = createTodoTools({ onChange });
    const model = mockModel([
      { toolCalls: [{ name: 'todo_write', args: { todos: [{ content: 'a', status: 'pending' }] } }] },
      { toolCalls: [{ name: 'todo_read' }] },
      'ok',
    ]);

    await createAgent({ prompt: 'p', provider: model, tools: todos.tools }).send('go');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([{ id: 'todo_1', content: 'a', status: 'pending' }]);
  });

  it('reads and writes through a custom (async) store', async () => {
    let saved: Todo[] = [{ id: 'todo_7', content: 'restored', status: 'pending' }];
    const store: TodoStore = {
      get: async () => saved,
      set: async (next) => {
        saved = next;
      },
    };
    const todos = createTodoTools({ store });
    const model = mockModel([
      { toolCalls: [{ name: 'todo_read' }] },
      { toolCalls: [{ name: 'todo_write', args: { todos: [{ content: 'restored', status: 'completed' }, { content: 'new', status: 'pending' }] } }] },
      'ok',
    ]);

    await createAgent({ prompt: 'p', provider: model, tools: todos.tools }).send('go');

    expect(saved).toEqual([
      { id: 'todo_7', content: 'restored', status: 'completed' },
      { id: 'todo_8', content: 'new', status: 'pending' },
    ]);
    expect(await todos.getTodos()).toBe(saved);
  });

  it('keeps separate in-memory lists per createTodoTools() call', async () => {
    const a = createTodoTools();
    const b = createTodoTools();
    await (a.todoWrite.tool.execute as (args: unknown, ctx: unknown) => Promise<unknown>)(
      { todos: [{ content: 'only a', status: 'pending' }] },
      {}
    );
    expect(await a.getTodos()).toHaveLength(1);
    expect(await b.getTodos()).toHaveLength(0);
  });

  it('describes when to use each tool', () => {
    const { todoWrite, todoRead } = createTodoTools();
    expect(todoWrite.description).toMatch(/multi-step|three or more steps/);
    expect(todoRead.name).toBe('todo_read');
  });
});
