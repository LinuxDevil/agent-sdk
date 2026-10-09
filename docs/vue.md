# Vue

`useLoushoAgent()` for Vue 3 is the [React hook](./react.md) as a composable:
the same sources, the same state and the same actions, over the same
[typed event stream](./streaming.md). Read [React](./react.md) for what each
field means, the two kinds of source, how approvals work and the server side;
this page covers what differs.

It lives in the `@lousho/build-ai-agent/vue` subpath. `vue` (3.x) is an
optional peer dependency: install it in the app that uses the composable.

```ts
import { useLoushoAgent } from '@lousho/build-ai-agent/vue';

// In <script setup>:
const { messages, status, pendingApproval, send, stop, approve, reject, reset } = useLoushoAgent(
  { url: '/api/agent' },
  { approvalsUrl: '/api/approvals' }
);

export async function submit(text: string): Promise<void> {
  if (text.trim() && status.value !== 'streaming') await send(text);
}

export { messages, status, pendingApproval, stop, approve, reject, reset };
```

and in the template:

```html
<article v-for="message in messages" :key="message.id">
  <header>{{ message.role }}</header>
  <p>{{ message.text }}</p>
  <code v-for="call in message.toolCalls" :key="call.id">{{ call.name }}: {{ call.status }}</code>
</article>
<p v-if="pendingApproval">
  Run {{ pendingApproval.toolName }}?
  <button @click="approve()">Approve</button>
  <button @click="reject('Not now')">Reject</button>
</p>
<button v-if="status === 'streaming'" @click="stop">Stop</button>
```

## What differs from React

- **State is refs.** `messages`, `status`, `pendingApproval`, `error`, `usage`, `finishReason`,
  `todos` and `lastEvent` are read-only `ComputedRef`s: use `.value` in script,
  nothing in a template. The commands (`send`, `stop`, `approve`, `reject`,
  `answer`) are plain functions with the React hook's signatures.
- **`reset()`** aborts the run in flight, forgets the in-process session
  (`{ agent, sessionId }` starts a new conversation; a remote `{ url }` source gets a new generated chat id) and clears the state.
- **The source and options can be refs.** Pass a plain object or a `ref`; it is
  read when a turn starts, so a changed `url` or `agent` applies to the next
  turn.
- **Cleanup is scope disposal.** `stop()` aborts the request in flight, and so
  does stopping the owning scope: a component unmounting, or
  `effectScope().stop()` in tests and plain scripts. Called outside any scope,
  the composable has nothing to dispose: call `stop()` yourself.

The reducer and the stream parser are exported from this subpath too
(`reduceAgentEvents`, `initialAgentUIState`, `parseEventStream`), the same
ones as in `@lousho/build-ai-agent/react`.

## Todos

`useTodos(agent)` takes the composable's result and returns one read-only ref
per field of the todo view: `todos`, `counts`, `current` (the `in_progress`
item, else the first `pending` one) and `progress` (`completed / total`). It
shows the plan of an agent with the [todo tools](./tools.md#todo-tools) live, from
the same stream as the chat (see [React](./react.md#todos)).

```ts
import { useLoushoAgent, useTodos } from '@lousho/build-ai-agent/vue';

// In <script setup>:
const agent = useLoushoAgent({ url: '/api/agent' });
const { todos, counts, current, progress } = useTodos(agent);

export { agent, todos, counts, current, progress };
```

```html
<p>{{ counts.completed }} of {{ counts.total }} done ({{ Math.round(progress * 100) }}%)</p>
<p v-if="current">Now: {{ current.content }}</p>
<ul>
  <li v-for="todo in todos" :key="todo.id">{{ todo.status }}: {{ todo.content }}</li>
</ul>
```
