/**
 * How each `{ builtin }` tool reference of an AgentSpec v2 spec builds its
 * tool(s): one factory per name the spec may write, keyed by the model-facing
 * name (`current_date`, `web_fetch`, `todo`). One ref can stand for several
 * tools — `todo` yields `todo_write` and `todo_read`, sharing one store —
 * so each factory returns the tools keyed by the name the model calls.
 * Node-side: the built-ins it imports pull in `node:*`, so the browser-safe
 * spec schema (`src/spec/v2/tools.ts`) only names the same key set through
 * `BUILTIN_TOOL_OPTIONS`, and this mapped type keeps the two equal at compile
 * time. Read by `src/spec/v2/resolve/tools.ts`; not part of the tools index.
 */
import type { ToolDescriptor } from '../types';
import type { BUILTIN_TOOL_OPTIONS } from '../spec/v2/tools';
import { currentDateTool } from './built-in/currentDate';
import { dayNameTool } from './built-in/dayName';
import { createHttpTool, type HttpToolOptions } from './built-in/http';
import { createTodoTools } from './built-in/todo';
import { createWebFetchTool, type WebFetchToolOptions } from './built-in/webFetch';

/**
 * One `{ builtin: <key> }` ref → the tools it registers, keyed by model-facing
 * name. `options` is the ref's already-validated options record.
 */
export const BUILTIN_TOOL_FACTORIES: {
  [K in keyof typeof BUILTIN_TOOL_OPTIONS]: (options: Record<string, unknown>) => Record<string, ToolDescriptor>;
} = {
  current_date: () => ({ current_date: currentDateTool }),
  day_name: () => ({ day_name: dayNameTool }),
  http_request: (options) => ({ http_request: createHttpTool(options as HttpToolOptions) }),
  web_fetch: (options) => ({ web_fetch: createWebFetchTool(options as WebFetchToolOptions) }),
  todo: () => {
    const { todoWrite, todoRead } = createTodoTools();
    return { todo_write: todoWrite, todo_read: todoRead };
  },
};
