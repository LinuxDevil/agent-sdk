// tools.md:243
import { createAgent, createTodoTools, type TodoStore } from '@lousho/build-ai-agent';

const todos = createTodoTools({ onChange: (list) => console.log(list.length, 'todos') });
const planner = createAgent({ prompt: 'Plan multi-step work, then do it.', provider, tools: todos.tools });

await planner.send('Migrate the repo to ESM');
console.log(await todos.getTodos()); // [{ id: 'todo_1', content: '...', status: 'completed' }, ...]

// Persist the list somewhere else:
let saved: Awaited<ReturnType<TodoStore['get']>> = [];
createTodoTools({ store: { get: () => saved, set: (next) => void (saved = next) } });
export {};
