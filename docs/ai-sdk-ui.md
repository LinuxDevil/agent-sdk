# AI SDK UI (`useChat`)

If your front end already uses the Vercel AI SDK's UI hooks (`useChat` from
`@ai-sdk/react`, and the Vue, Svelte and Angular equivalents), you can keep
them and run a Lousho agent behind the route. Three functions, exported from
the package root, do the translation. They import nothing from `ai`, use no
`node:*` module, and work on Node, Workers and any Fetch-based runtime.

| Function | Direction | What it does |
| --- | --- | --- |
| `toUIMessageStream(run)` | out | the run's events as a `ReadableStream` of UI message chunks |
| `toUIMessageStreamResponse(run, init?)` | out | a `Response`: SSE, `data: [DONE]` at the end, header `x-vercel-ai-ui-message-stream: v1` |
| `fromUIMessages(messages, { lastUserOnly? })` | in | the `UIMessage[]` `useChat` posts as an `AgentInput` |

## Route handler

The `vendor/` model prefix chooses the provider; with OpenRouter use
`openrouter/<vendor>/<model>` (e.g. `openrouter/openai/gpt-4o-mini`).

```ts
import { createAgent, fromUIMessages, memoryStore, toUIMessageStreamResponse, type UIMessageLike } from '@lousho/build-ai-agent';

// The store must outlive the request: without one, every `agent.session({ id })`
// gets a fresh in-memory transcript and the next turn would start empty.
// `memoryStore()` keeps it for the process's life; for a serverless deployment
// or to survive a restart use `fileStore()`, a `SqliteStore` or `KVStore`
// (see [Sessions](sessions.md#choosing-a-store)).
const agent = createAgent({ model: 'openai/gpt-4o-mini', instructions: 'You are helpful.', store: memoryStore() });

// app/api/chat/route.ts
export async function POST(request: Request): Promise<Response> {
  const { id, messages } = (await request.json()) as { id: string; messages: UIMessageLike[] };
  // The session (keyed on the chat id) keeps the transcript, so only the new user message is the input.
  const session = agent.session({ id });
  return toUIMessageStreamResponse(session.stream(fromUIMessages(messages, { lastUserOnly: true })));
}
```

Without a session, pass every message instead:
`toUIMessageStreamResponse(agent.stream(fromUIMessages(messages)))`.

## Client

```tsx no-verify
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

export function Chat() {
  const { messages, sendMessage } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });
  return (
    <>
      {messages.map((message) =>
        message.parts.map((part, i) =>
          part.type === 'text' ? <p key={i}>{part.text}</p> : null
        )
      )}
      <button onClick={() => sendMessage({ text: 'Weather in Paris?' })}>Ask</button>
    </>
  );
}
```

This snippet targets `ai` 6 and 7 (`useChat` takes a `transport`, and
`sendMessage` posts the message). On `ai` 4 — also a supported peer —
`useChat({ api: '/api/chat' })` takes the endpoint directly and returns
`input` / `handleInputChange` / `handleSubmit` instead of `sendMessage`;
`ai` 5 is not in the peer range.

## Event mapping

| Lousho event | UI message chunk |
| --- | --- |
| `run.start` | `start` (`messageId` is the run id) |
| `step.start` / `step.done` | `start-step` / `finish-step` |
| `text.delta`, `text.done` | `text-start` (once per text part), `text-delta`, `text-end` |
| `reasoning.start`, `reasoning.delta`, `reasoning.done` | `reasoning-start`, `reasoning-delta`, `reasoning-end` (see [Reasoning](./reasoning.md)) |
| `tool.start` | `tool-input-start`, then `tool-input-available` with the arguments |
| `tool.partial` | `tool-output-available` with `preliminary: true` (AI SDK 5+): a snapshot of a [streaming tool](./tools.md#streaming-partial-results) |
| `tool.done` / `tool.error` | `tool-output-available` / `tool-output-error` |
| `approval.requested` | `data-lousho-approval` (below) |
| `todo.updated` | `data-lousho-todos`: a data part `{ todos, counts }` with the complete todo list, under the id `todos` so each update replaces the last (see [Todo tools](./tools.md#todo-tools)) |
| `error` | `error` |
| `run.done` | `finish` |

A streaming tool's snapshots arrive as preliminary outputs, which `useChat`
shows as the tool part's `output` with `preliminary: true`; the `tool.done`
chunk after them has no `preliminary` and is the final output.

Events with no UI counterpart (retries, compaction, permission decisions,
guardrails, ...) and the events of sub-agents are not forwarded. The `finish`
chunk's `finishReason` is the AI SDK's (`stop`, `length`, `content-filter`,
`tool-calls`, `error`; anything else, such as `awaiting-approval` or
`max-steps`, is `other`).

## Usage and cost

Usage goes in the `finish` chunk's `messageMetadata`, so `message.metadata` on
the finished assistant message has it:

```json
{ "runId": "run_1", "loushoFinishReason": "stop", "usage": { "totalTokens": 120, "costUsd": 0.0004 } }
```

`usage` is the run's `AgentEventUsage` (absent when the run failed);
`loushoFinishReason` is the run's own finish reason, unmapped.

## Approvals and `ask_question`

A tool that needs approval, or an `ask_question` call, pauses the run: the
stream ends (`finish` with `loushoFinishReason: "awaiting-approval"`) after a
custom data part, which `useChat` shows as a part of type
`data-lousho-approval`:

```json
{
  "type": "data-lousho-approval",
  "id": "appr_1",
  "data": {
    "approvalId": "appr_1",
    "toolCallId": "call_1",
    "toolName": "deploy",
    "input": { "env": "prod" },
    "kind": "question",
    "question": { "text": "Which environment?", "options": ["staging", "prod"] }
  }
}
```

`kind` and `question` are present only for an `ask_question`; a tool waiting
for an [OAuth sign-in](./oauth.md#what-the-user-sees) instead carries
`kind: 'sign-in'` and `signIn: { provider, displayName?, url }` — show the
link and, once the provider redirected back, approve it ("I've signed in").
Render the part
with your own buttons and answer it with the session API's approvals route
(`POST /chat/:sessionId/approvals/:approvalId`, see [Sessions](sessions.md) and
[Approvals](approvals.md)): `{ "approved": true }` or `{ "approved": false,
"note": "..." }` for a tool, `{ "answer": "prod" }` for a question. The response
is the continuation as an event stream, which you can read with the UI
bindings' parser or ignore and call `useChat`'s `sendMessage` again; or, in
your own route, call `agent.approvals.streamResolve()` /
`streamAnswer()` and return `toUIMessageStreamResponse()` of the result, so
the continuation renders in the same chat.

## Inbound conversion

`fromUIMessages()` maps text parts to text, `image/*` file parts to image
parts and other file parts to file parts (the part's `url`, a `data:` or
`http(s)` URL, becomes the data). Tool, reasoning, data, source and unknown
parts are ignored, and messages that end up empty are dropped.

A dedicated `@lousho/build-ai-agent/ai-sdk-ui` subpath may follow; for now the
functions come from the package root.
