# React

`useLoushoAgent()` puts an agent behind a chat UI. It runs a turn, reads the
[typed event stream](./streaming.md) as it arrives and turns it into
render-ready state: messages with their text and tool calls, a `status` for
the composer, and the tool call waiting for approval, if any.

It lives in the `@lousho/build-ai-agent/react` subpath. `react` (18 or 19) is
an optional peer dependency: install it in the app that uses the hook.

```tsx
import { useLoushoAgent } from '@lousho/build-ai-agent/react';

export function Chat() {
  const agent = useLoushoAgent({ url: '/api/agent' });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const input = new FormData(event.currentTarget).get('message');
        if (typeof input === 'string' && input.trim()) void agent.send(input);
        event.currentTarget.reset();
      }}
    >
      {agent.messages.map((message) => (
        <article key={message.id}>
          <header>{message.role}</header>
          <p>{message.text}</p>
          {message.toolCalls.map((call) => (
            <code key={call.id}>{call.name}: {call.status}</code>
          ))}
        </article>
      ))}
      {agent.pendingApproval && (
        <p>
          Run {agent.pendingApproval.toolName}?
          <button type="button" onClick={() => void agent.approve()}>Approve</button>
          <button type="button" onClick={() => void agent.reject('Not now')}>Reject</button>
        </p>
      )}
      <input name="message" disabled={agent.status === 'streaming'} />
      {agent.status === 'streaming' && <button type="button" onClick={agent.stop}>Stop</button>}
    </form>
  );
}
```

## Sources

The first argument says where the agent runs.

| Source | What the hook does |
| ------ | ------------------ |
| `{ url, sessionId?, headers?, fetch? }` | **Remote.** `send(input)` POSTs `{ "input": "...", "sessionId": "..." }` as JSON to `url` and reads the response body as an event stream: SSE (`data: {...}` lines) or newline-delimited JSON, one event per line. The server below writes exactly that. The hook generates one `sessionId` per chat and sends it with every turn, so a session-aware server (`createRouteHandler`) keeps the conversation; pass your own `sessionId` to resume a stored session. `reset()` starts a new chat id. |
| `{ agent }` | **In process.** `send(input)` calls `agent.stream(input)`. Every turn is a new run with no history, like `agent.send()`. |
| `{ agent, sessionId }` | **In process, multi-turn.** The hook creates `agent.session({ id: sessionId })` once and streams each turn with `session.stream()`, so turns see the conversation so far. |

In-process mode is for React code that runs where the agent can (Electron,
React Native, tests). In a browser, use the remote mode: model API keys belong
on the server.

## Returned state

| Field | What it is |
| ----- | ---------- |
| `messages` | `UIMessage[]`: `{ id, role: 'user' \| 'assistant', text, toolCalls, reasoning? }`. Each `send()` adds a user message and an assistant message that fills in as `text.delta` and tool events arrive; `reasoning` collects the model's `reasoning.delta` text when it streams any. |
| `toolCalls[i]` | `{ id, name, args, status, result?, error?, partial? }`, `status` being `'running'`, `'awaiting-approval'`, `'done'`, `'error'` or `'rejected'`. `partial` is the latest `tool.partial` snapshot of a running [streaming tool](./tools.md#streaming-partial-results), removed when the call settles or pauses. |
| `status` | `'idle'`, `'streaming'`, `'awaiting-approval'` or `'error'`. |
| `pendingApproval` | `{ id, toolCallId, toolName, args }` of the tool call the run paused on, else `null`. For an `ask_question` call it also has `kind: 'question'` and `question: { text, options?, allowFreeText? }`; a tool waiting on an OAuth sign-in has `kind: 'sign-in'` and `signIn: { provider, displayName?, url }` (see [What the user sees](./oauth.md#what-the-user-sees)). |
| `error` | `{ name, message }` of the last `error` event or a failed request, else `null`. |
| `usage` | Token usage of the last finished run (from `run.done`), else `null`. |
| `todos` | The agent's todo list (`{ id, content, status }[]`), set by each `todo.updated` event of the [todo tools](./tools.md#todo-tools); `[]` until the first one. It carries across turns; see [Todos](#todos). |
| `lastEvent` | The last event received, for anything the projection does not cover. |
| `send(input)` | Starts a turn. If a turn is still running, it is aborted first. `input` is a string, content parts or a `Message[]` (an `AgentInput`); the user bubble shows the text with an `[image]` / `[file]` marker per other part (remote mode POSTs it as `{ "input": ... }`). |
| `stop()` | Aborts the turn in flight through its `AbortSignal`; `status` goes back to `'idle'`. |
| `approve(note?)`, `reject(note?)` | Decide `pendingApproval` (see below). |
| `answer(text)` | Answers a question (`pendingApproval.kind === 'question'`); the same as `approve(text)`. `reject()` declines it. |

Unmounting the component aborts the turn in flight. Events of a
[sub-agent](./sub-agents.md)'s run (they carry `subagent`) do not change
`messages` — except a sub-agent's `approval.requested`, which does update
`messages`, `pendingApproval` and `status` (the pause is the user's to decide).
Read other sub-agent events from `lastEvent` if you want to show them.

## Approvals

When a tool with `needsApproval` is called, the run stops with
`approval.requested`. `status` becomes `'awaiting-approval'` and
`pendingApproval` holds the call. Then:

- **In process**, `approve(note?)` and `reject(note?)` call
  `agent.approvals.streamResolve({ id, approved, note }, { signal })` (see
  [Approvals](./approvals.md)). The continued run's events stream in live, so
  its text is appended to the assistant message as it arrives and `status`
  returns to `'idle'`, or to `'awaiting-approval'` if the run pauses again.
- **Remote**, pass `{ approvalsUrl }` as the second argument. The hook POSTs
  `{ "approved": true, "note": "..." }` to `${approvalsUrl}/${approvalId}` and
  shows the continuation live from the SSE stream the session API answers
  with (the same events as a chat turn; a second pause arrives as
  `approval.requested`). A server that answers with an `ApprovalOutcome` JSON
  instead (the one below) still works.
- **Remote without `approvalsUrl`**, `approve()` and `reject()` do nothing.
  Show `pendingApproval` and resolve it through your own API, then `send()`
  the next turn.

An agent created with `askQuestion: true` can ask the user something (see
[Asking the user a question](./approvals.md#asking-the-user-a-question)). The
pause arrives the same way, with `pendingApproval.kind === 'question'`: show
`pendingApproval.question.text` and its `options`, and call `answer(text)`.

## The server side

A Node endpoint for the remote mode, with the approvals route (the `vendor/`
model prefix chooses the provider; with OpenRouter use
`openrouter/<vendor>/<model>`, e.g. `openrouter/openai/gpt-4o-mini`):

```ts
import { createServer, type IncomingMessage } from 'node:http';
import { createAgent } from '@lousho/build-ai-agent';
import type { ApprovalOutcome } from '@lousho/build-ai-agent/react';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

createServer(async (req, res) => {
  const body = await readJson(req);
  const approval = /^\/api\/approvals\/(.+)$/.exec(req.url ?? '');

  if (approval) {
    const id = decodeURIComponent(approval[1]);
    const note = typeof body.note === 'string' ? body.note : undefined;
    const result = await agent.approvals.resolve({ id, approved: body.approved === true, note });
    const next = (await agent.approvals.list()).find((pending) => pending.id === result.approvalId);
    const outcome: ApprovalOutcome = { text: result.text, finishReason: result.finishReason, usage: result.usage, approval: next };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(outcome));
    return;
  }

  const controller = new AbortController();
  res.on('close', () => controller.abort()); // the hook's stop() or unmount closes the request
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for await (const event of agent.stream(String(body.input), { signal: controller.signal })) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}).listen(3000);
```

The client then uses
`useLoushoAgent({ url: '/api/agent' }, { approvalsUrl: '/api/approvals' })`.
For a multi-turn chat, keep an `agent.session({ id })` per conversation on the
server and call `session.stream()` instead of `agent.stream()`. Give the agent
a `store` (`createAgent({ store: memoryStore() })`, or a durable one) when
sessions are opened per request: without one each `agent.session({ id })`
gets a fresh in-memory transcript and the next turn forgets the first (see
[Choosing a store](./sessions.md#choosing-a-store)).

## In process

The hook takes the agent itself, too. Called from a custom hook:

```ts
import { createAgent } from '@lousho/build-ai-agent';
import { useLoushoAgent } from '@lousho/build-ai-agent/react';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });

export function useSupportChat() {
  const chat = useLoushoAgent({ agent, sessionId: 'support' });
  const lastReply = chat.messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? '';
  return { ...chat, lastReply, busy: chat.status === 'streaming' };
}
```

## Without React

The hook is a thin wrapper. The state logic is `reduceAgentEvents(state,
event)`, a pure reducer over `AgentEvent`s and a few local actions
(`ui.send`, `ui.decide`, `ui.resumed`, `ui.stopped`, `ui.reset`, `ui.error`), and
`parseEventStream(response)` reads events back from a fetch response. Both are
exported from the same subpath, for a custom binding or a non-React client:

```ts
import { initialAgentUIState, parseEventStream, reduceAgentEvents } from '@lousho/build-ai-agent/react';

let state = reduceAgentEvents(initialAgentUIState, { type: 'ui.send', input: 'Weather in Paris?' });
const response = await fetch('http://localhost:3000/api/agent', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: 'Weather in Paris?' }),
});
for await (const event of parseEventStream(response)) {
  state = reduceAgentEvents(state, event);
}
console.log(state.status, state.messages.at(-1)?.text, state.usage?.totalTokens);
```

`parseEventStream()` skips blank lines, SSE comments and `event:`/`id:`
fields, and any line that is not a known event, so it reads both framings.
Breaking out of its loop cancels the response body.

## Todos

An agent that has the [todo tools](./tools.md#todo-tools) emits a
`todo.updated` event for every `todo_write`; the hook keeps the latest list in
`todos`, and `useTodos(agent)` turns it into a view with counts, the item being
worked on and the progress. It takes the hook's result, so one stream feeds the
chat and the plan. The list carries across turns and is cleared by nothing but a
new hook (it is not restored when the page reconnects to an existing session).

```tsx
import { useLoushoAgent, useTodos } from '@lousho/build-ai-agent/react';

export function Plan() {
  const agent = useLoushoAgent({ url: '/api/agent' });
  const { todos, counts, current, progress } = useTodos(agent);

  return (
    <aside>
      <p>
        {counts.completed} of {counts.total} done ({Math.round(progress * 100)}%)
        {current && <> - now: {current.content}</>}
      </p>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            {todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[>]' : '[ ]'} {todo.content}
          </li>
        ))}
      </ul>
      <button onClick={() => agent.send('Migrate the repo to ESM')}>Start</button>
    </aside>
  );
}
```

`current` is the `in_progress` item, else the first `pending` one, and `undefined`
when nothing is left; `progress` is `completed / total` (0 for an empty list).
The view is memoized on `agent.todos`. `todoView(todos)` computes the same view
outside React.
