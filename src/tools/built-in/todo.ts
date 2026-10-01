/**
 * Built-in todo tools (LOU-X7).
 *
 * Lets a long-running agent plan and track multi-step work. `todo_write`
 * replaces the whole list, `todo_read` returns it, and both share one store.
 */
import { z } from 'zod';
import { defineTool } from '../defineTool';

/** Progress of a {@link Todo}. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** One tracked task. */
export interface Todo {
  /** Stable identifier (assigned automatically when omitted). */
  id: string;
  /** What needs doing, in imperative form. */
  content: string;
  status: TodoStatus;
}

/**
 * Where the todo list lives. Implement it to persist the list (database,
 * file, session state). Both methods may be async.
 *
 * @example
 * ```ts
 * const saved: Todo[] = [];
 * const store: TodoStore = { get: () => saved, set: (todos) => { saved.splice(0, saved.length, ...todos); } };
 * ```
 */
export interface TodoStore {
  get(): Todo[] | Promise<Todo[]>;
  set(todos: Todo[]): void | Promise<void>;
}

/** Options for {@link createTodoTools}. */
export interface TodoToolsOptions {
  /** Backing store. Defaults to a fresh in-memory store per `createTodoTools()` call. */
  store?: TodoStore;
  /** Called with the new list after every `todo_write` (e.g. to re-render a UI). */
  onChange?: (todos: readonly Todo[]) => void | Promise<void>;
}

/** What `todo_write` and `todo_read` return to the model. */
export interface TodoListResult {
  todos: Todo[];
  counts: Record<TodoStatus, number> & { total: number };
}

/** The tools and host accessor returned by {@link createTodoTools}. */
export interface TodoTools {
  /** `[todo_write, todo_read]`, ready for `createAgent({ tools })`. */
  tools: [TodoWriteTool, TodoReadTool];
  todoWrite: TodoWriteTool;
  todoRead: TodoReadTool;
  /** The current list, for the host application. */
  getTodos(): Promise<Todo[]>;
}

const todoItem = z.object({
  id: z.string().min(1).optional().describe('Keep the id of an existing item to update it; omit for new items.'),
  content: z.string().trim().min(1).describe('Imperative description of the task.'),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

type TodoItemInput = z.output<typeof todoItem>;

function validateList(items: TodoItemInput[], ctx: z.RefinementCtx): void {
  const inProgress = items.filter((item) => item.status === 'in_progress').length;
  if (inProgress > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `At most one todo may be in_progress, got ${inProgress}. Mark the others pending or completed.`,
    });
  }
  const ids = items.flatMap((item) => (item.id === undefined ? [] : [item.id]));
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Todo ids must be unique.' });
  }
}

const writeInput = z.object({
  todos: z.array(todoItem).superRefine(validateList).describe('The complete list; replaces the previous one.'),
});

function summarize(todos: Todo[]): TodoListResult {
  const counts = { pending: 0, in_progress: 0, completed: 0, total: todos.length };
  for (const todo of todos) counts[todo.status] += 1;
  return { todos, counts };
}

/** Gives every item an id: explicit ones are kept, matching content reuses the existing id, the rest get a new one. */
function assignIds(items: TodoItemInput[], existing: Todo[]): Todo[] {
  const used = new Set<string>([
    ...items.flatMap((item) => (item.id === undefined ? [] : [item.id])),
  ]);
  const reusable = new Map<string, string[]>();
  for (const todo of existing) {
    if (used.has(todo.id)) continue;
    reusable.set(todo.content, [...(reusable.get(todo.content) ?? []), todo.id]);
  }
  const taken = new Set<string>([...used, ...existing.map((todo) => todo.id)]);
  let counter = Math.max(0, ...[...taken].map((id) => Number(/^todo_(\d+)$/.exec(id)?.[1] ?? 0)));
  const fresh = (): string => {
    do counter += 1;
    while (taken.has(`todo_${counter}`));
    taken.add(`todo_${counter}`);
    return `todo_${counter}`;
  };
  return items.map((item) => ({
    id: item.id ?? reusable.get(item.content)?.shift() ?? fresh(),
    content: item.content,
    status: item.status,
  }));
}

type TodoWriteTool = ReturnType<typeof buildWriteTool>;
type TodoReadTool = ReturnType<typeof buildReadTool>;

function memoryStore(): TodoStore {
  let todos: Todo[] = [];
  return {
    get: () => todos,
    set: (next) => {
      todos = next;
    },
  };
}

function buildWriteTool(store: TodoStore, onChange: TodoToolsOptions['onChange']) {
  return defineTool({
    name: 'todo_write',
    description:
      'Plan and track multi-step work. Use it at the start of any task with three or more steps, and update it as you go: ' +
      'send the COMPLETE list each time (it replaces the previous one), keep at most one item in_progress, and mark items ' +
      'completed as soon as they are done. Skip it for simple one-step requests.',
    input: writeInput,
    async execute({ todos }): Promise<TodoListResult> {
      const next = assignIds(todos, await store.get());
      await store.set(next);
      await onChange?.(next);
      return summarize(next);
    },
  });
}

function buildReadTool(store: TodoStore) {
  return defineTool({
    name: 'todo_read',
    description: 'Return the current todo list with counts per status. Use it to re-check what is left before continuing or finishing.',
    input: z.object({}),
    async execute(): Promise<TodoListResult> {
      return summarize(await store.get());
    },
  });
}

/**
 * Create the `todo_write` / `todo_read` tools, sharing one store.
 *
 * @example
 * ```ts
 * const todos = createTodoTools({ onChange: (list) => render(list) });
 * const agent = createAgent({ prompt: 'Plan, then do.', provider, tools: todos.tools });
 * await agent.send('Migrate the repo to ESM');
 * console.log(await todos.getTodos());
 * ```
 */
export function createTodoTools(options: TodoToolsOptions = {}): TodoTools {
  const store = options.store ?? memoryStore();
  const todoWrite = buildWriteTool(store, options.onChange);
  const todoRead = buildReadTool(store);
  return {
    tools: [todoWrite, todoRead],
    todoWrite,
    todoRead,
    async getTodos() {
      return store.get();
    },
  };
}
