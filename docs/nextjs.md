# Next.js and other Fetch-API frameworks

`createRouteHandler(agent, options?)` serves an agent from a route file of any
framework whose handlers take a Web `Request` and return a `Response`: the
Next.js App Router, SvelteKit, Remix / React Router, Hono, Bun.serve. It is a
thin wrapper over the same session API as `lousho dev` and the deployed server
([Deployment](./deployment.md)), so the React, Vue and Svelte bindings work against it
unchanged. It imports no framework and no `node:*` module. The `vendor/` model
prefix chooses the provider; with OpenRouter use `openrouter/<vendor>/<model>`
(e.g. `openrouter/openai/gpt-4o-mini`).

## Next.js App Router

```ts
// app/api/agent/[[...path]]/route.ts
import { createAgent, createRouteHandler, memoryStore } from '@lousho/build-ai-agent';

// `store` is what lets a session survive across requests: without one every
// `agent.session({ id })` the handler opens gets a fresh in-memory transcript,
// so a second turn forgets the first and `GET /chat/:id` returns empty.
const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  instructions: 'You are helpful.',
  store: memoryStore(), // lives in the server process; use a durable store on serverless
});

export const { GET, POST } = createRouteHandler(agent, {
  basePath: '/api/agent',
  auth: process.env.AGENT_TOKEN,
  uiMessageStream: true,
});
```

**A route with no `auth` is public**: anyone who can reach it can run your agent
and spend your model budget. Pass a bearer token, or a function that checks your
own session or cookie:

```ts
import { createAgent, createRouteHandler } from '@lousho/build-ai-agent';

declare function isSignedIn(request: Request): Promise<boolean>;

export const { GET, POST } = createRouteHandler(createAgent({ model: 'openai/gpt-4o-mini' }), {
  auth: (request) => isSignedIn(request),
});
```

## Routes

All paths are under `basePath` (default `/api/agent`; a trailing slash is
accepted, and a request outside the base path is a 404).

| Route | What it does |
| --- | --- |
| `POST <basePath>` | `{ input, sessionId? }`: the turn streamed as SSE. This is what `useLoushoAgent({ url })` posts; without a `sessionId` each turn is a fresh session |
| `POST <basePath>/approvals/:id` | `{ approved, note? }` or `{ answer }`: the continuation streamed (`useLoushoAgent`'s `approvalsUrl`) |
| `POST <basePath>/chat` | `{ sessionId, input }`: the session API of the deployed server |
| `GET <basePath>/chat/:sessionId` | the session's transcript and pending approvals |
| `POST <basePath>/chat/:sessionId/approvals/:id` | decide an approval in a session |
| `POST <basePath>/ui` | with `uiMessageStream: true`: the AI SDK `useChat` endpoint |
| `GET <basePath>/oauth/callback` | the OAuth provider's redirect after a sign-in; never behind `auth` (the single-use `state` protects it) |
| `GET <basePath>/health` | `ok`, never behind `auth` |

Sessions are kept by the agent's `store` (`createAgent({ store })`), so give
the agent one that outlives a serverless invocation when you use sessions.

`auth` also takes an ordered list of `jwt()`, `oidc()`, `basic()` and
`apiToken()` entries, and the caller it accepts reaches the run as `principal`:
see [Route auth and principals](./auth.md).

## Client: `useLoushoAgent`

```tsx no-verify
'use client';
import { useLoushoAgent } from '@lousho/build-ai-agent/react';

export function Chat() {
  const agent = useLoushoAgent({ url: '/api/agent', headers: { Authorization: `Bearer ${token}` } }, { approvalsUrl: '/api/agent/approvals' });
  // agent.messages, agent.send(text), agent.approve() ...
}
```

## Client: `useChat`

With `uiMessageStream: true`, point `useChat` at the `ui` route. The chat `id`
names the session, so only the newest user message is sent to the agent
([AI SDK UI](./ai-sdk-ui.md)).

```tsx no-verify
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

// ai 6/7 signature; on ai 4 (also a supported peer) use useChat({ api: '/api/agent/ui' })
const { messages, sendMessage } = useChat({ transport: new DefaultChatTransport({ api: '/api/agent/ui' }) });
```

## Other frameworks

The same handler, mounted where the framework wants it:

```ts
import { createAgent, createRouteHandler } from '@lousho/build-ai-agent';

const { handler } = createRouteHandler(createAgent({ model: 'openai/gpt-4o-mini' }), { basePath: '/agent', auth: 'secret' });

// SvelteKit: src/routes/agent/[...path]/+server.ts
export const GET = ({ request }: { request: Request }) => handler(request);
export const POST = ({ request }: { request: Request }) => handler(request);

// Hono: app.all('/agent/*', (c) => handler(c.req.raw))
// Bun.serve: fetch: handler
```
