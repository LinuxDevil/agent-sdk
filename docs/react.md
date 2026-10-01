# React

`useLoushyAgent()` puts an agent behind a chat UI. It runs a turn, reads the
[typed event stream](./streaming.md) as it arrives and turns it into
render-ready state: messages with their text and tool calls, a `status` for
the composer, and the tool call waiting for approval, if any.

It lives in the `@loushy/build-ai-agent/react` subpath. `react` (18 or 19) is
an optional peer dependency: install it in the app that uses the hook.

```tsx
import { useLoushyAgent } from '@loushy/build-ai-agent/react';

export function Chat() {
  const agent = useLoushyAgent({ url: '/api/agent' });

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
| `{ url, headers?, fetch? }` | **Remote.** `send(input)` POSTs `{ "input": "..." }` as JSON to `url` and reads the response body as an event stream: SSE (`data: {...}` lines) or newline-delimited JSON, one event per line. The server below writes exactly that. |
| `{ agent }` | **In process.** `send(input)` calls `agent.stream(input)`. Every turn is a new run with no history, like `agent.send()`. |
| `{ agent, sessionId }` | **In process, multi-turn.** The hook creates `agent.session({ id: sessionId })` once and streams each turn with `session.stream()`, so turns see the conversation so far. |

In-process mode is for React code that runs where the agent can (Electron,
React Native, tests). In a browser, use the remote mode: model API keys belong
on the server.

## Returned state

| Field | What it is |
| ----- | ---------- |
| `messages` | `UIMessage[]`: `{ id, role: 'user' \| 'assistant', text, toolCalls }`. Each `send()` adds a user message and an assistant message that fills in as `text.delta` and tool events arrive. |
| `toolCalls[i]` | `{ id, name, args, status, result?, error? }`, `status` being `'running'`, `'awaiting-approval'`, `'done'`, `'error'` or `'rejected'`. |
| `status` | `'idle'`, `'streaming'`, `'awaiting-approval'` or `'error'`. |
| `pendingApproval` | `{ id, toolCallId, toolName, args }` of the tool call the run paused on, else `null`. |
| `error` | `{ name, message }` of the last `error` event or a failed request, else `null`. |
| `usage` | Token usage of the last finished run (from `run.done`), else `null`. |
| `lastEvent` | The last event received, for anything the projection does not cover. |
| `send(input)` | Starts a turn. If a turn is still running, it is aborted first. `input` is a string, content parts or a `Message[]` (an `AgentInput`); the user bubble shows the text with an `[image]` / `[file]` marker per other part (remote mode POSTs it as `{ "input": ... }`). |
| `stop()` | Aborts the turn in flight through its `AbortSignal`; `status` goes back to `'idle'`. |
| `approve(note?)`, `reject(note?)` | Decide `pendingApproval` (see below). |

Unmounting the component aborts the turn in flight. Events of a
[sub-agent](./sub-agents.md)'s run (they carry `subagent`) do not change
`messages`; read them from `lastEvent` if you want to show them.

## Approvals

When a tool with `needsApproval` is called, the run stops with
`approval.requested`. `status` becomes `'awaiting-approval'` and
`pendingApproval` holds the call. Then:

- **In process**, `approve(note?)` and `reject(note?)` call
  `agent.approvals.resolve({ id, approved, note })` (see
  [Approvals](./approvals.md)). The continued run's text is appended to the
  assistant message and `status` returns to `'idle'`, or to
  `'awaiting-approval'` if the run pauses again.
- **Remote**, pass `{ approvalsUrl }` as the second argument. The hook POSTs
  `{ "approved": true, "note": "..." }` to `${approvalsUrl}/${approvalId}` and
  expects the `ApprovalOutcome` JSON the server below returns.
- **Remote without `approvalsUrl`**, `approve()` and `reject()` do nothing.
  Show `pendingApproval` and resolve it through your own API, then `send()`
  the next turn.

## The server side

A Node endpoint for the remote mode, with the approvals route:

```ts
import { createServer, type IncomingMessage } from 'node:http';
import { createAgent } from '@loushy/build-ai-agent';
import type { ApprovalOutcome } from '@loushy/build-ai-agent/react';

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
`useLoushyAgent({ url: '/api/agent' }, { approvalsUrl: '/api/approvals' })`.
For a multi-turn chat, keep an `agent.session({ id })` per conversation on the
server and call `session.stream()` instead of `agent.stream()`.

## In process

The hook takes the agent itself, too. Called from a custom hook:

```ts
import { createAgent } from '@loushy/build-ai-agent';
import { useLoushyAgent } from '@loushy/build-ai-agent/react';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });

export function useSupportChat() {
  const chat = useLoushyAgent({ agent, sessionId: 'support' });
  const lastReply = chat.messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? '';
  return { ...chat, lastReply, busy: chat.status === 'streaming' };
}
```

## Without React

The hook is a thin wrapper. The state logic is `reduceAgentEvents(state,
event)`, a pure reducer over `AgentEvent`s and a few local actions
(`ui.send`, `ui.decide`, `ui.resumed`, `ui.stopped`, `ui.error`), and
`parseEventStream(response)` reads events back from a fetch response. Both are
exported from the same subpath, for a custom binding or a non-React client:

```ts
import { initialAgentUIState, parseEventStream, reduceAgentEvents } from '@loushy/build-ai-agent/react';

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
