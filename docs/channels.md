# Channels

A **channel** connects an agent to one surface: a JSON API, a webhook, a chat
app. It says how an inbound request is authenticated, which conversation it
belongs to, and how the agent's reply (or an approval it pauses on) goes back
to the surface. `mountChannels()` serves your channels behind one `(req, res)`
handler and runs every request the same way:

```text
POST <basePath>/<name>  ->  verify  ->  parse  ->  session turn  ->  reply (or onApproval)
```

Channels are new (LOU-P7). The [trigger adapters](api-overview.md#triggers)
still work: `WebhookTriggerAdapter` now uses `webhookChannel()` for its auth and
parsing. Channels add what triggers lack: each conversation on the surface is
a [session](sessions.md), and approvals and questions go back to the surface.

## Quick start

`httpChannel()` is the reference channel: `{ sessionKey, input }` in, JSON out.

```ts
import * as http from 'node:http';
import { createAgent, createMockProvider, httpChannel, mountChannels } from '@loushy/build-ai-agent';

const agent = createAgent({ instructions: 'You are helpful.', provider: createMockProvider() });
const channels = mountChannels(agent, [httpChannel()]);

const server = http.createServer((req, res) => {
  void channels(req, res).then((handled) => {
    if (!handled) res.writeHead(404).end();
  });
});
server.listen(3000);
```

```bash
curl -s localhost:3000/channels/http -d '{"sessionKey":"user-42","input":"Hi, I am Ali"}'
# {"sessionId":"http_user-42-...","text":"...","finishReason":"stop"}
```

The handler resolves `true` when it served the request and `false` (nothing
written) for any other route, like the `/chat` routes of `loushy dev`, so you
can mount it next to your own routes.

## The contract

`defineChannel({ ... })` checks the name and returns the definition:

| Field | Description |
| ----- | ----------- |
| `name` | Route segment: `POST <basePath>/<name>`. Letters, digits, `_` and `-`. |
| `verify(req)` | Optional. Authenticate the request (a signature, a token). Return `true`/`false` or `{ ok, reason? }`; `false` answers `401 {"error":"Unauthorized"}` before anything is parsed or run. |
| `parse(req)` | The message: `{ sessionKey, input, metadata?, replyTo, event? }`, or `null` to acknowledge the request without a turn (a bot's own message, a retry). |
| `reply(ctx)` | Deliver the reply: `ctx.text`, plus `inbound`, `sessionId`, `result`, `events`, `approval`, and `respond(status, body)` while the request is still open. |
| `onApproval(ctx)` | Optional. Render a pause (buttons, a form). Default: `reply` with a text prompt in `ctx.text` and the request in `ctx.approval`. |
| `stream` | Optional. `true` calls `reply` with `partial: true` and the text so far as the model writes, then once more with the final text. |
| `sessionId(inbound)` | Optional. The session for a message. Default: `` `${name}:${sessionKey}` ``. |

`req` is a framework-free `ChannelRequest`: `method`, `url`, `headers`
(lower-case names), `rawBody` (the exact bytes: verify signatures over these,
never over re-serialized JSON), `text` and `native` (the host's request).

A reply that does not call `respond` is followed by `200 {"ok":true}`; a surface
that delivers replies out of band (posting to a chat API) only needs to
acknowledge the request. An error thrown by `parse` answers 400 for a
`SyntaxError` (bad JSON) and 500 otherwise; a body over 1MB gets 413.

```ts
import { createAgent, defineChannel, mountChannels } from '@loushy/build-ai-agent';

const agent = createAgent({ instructions: 'You answer text messages.', provider });

interface SmsEvent {
  from: string;
  body: string;
}

const sms = defineChannel<SmsEvent>({
  name: 'sms',
  async verify(req) {
    return req.headers['x-api-key'] === process.env.SMS_API_KEY;
  },
  async parse(req) {
    const event = JSON.parse(req.text) as SmsEvent;
    return { sessionKey: event.from, input: event.body, replyTo: event.from, event };
  },
  async reply({ inbound, text }) {
    console.log(`SMS to ${inbound.event?.from}: ${text}`); // call your SMS API here
  },
});

const handler = mountChannels(agent, [sms], { basePath: '/hooks' }); // POST /hooks/sms
```

## Sessions

Messages with the same `sessionKey` on the same channel share one session, so
the agent sees the earlier exchanges; turns of one session run one at a time.
Session ids allow only `A-Za-z0-9_-`, so an id with other characters (the
default `` `${name}:${sessionKey}` `` always has the `:`) has them replaced by
`_` and a hash of the original appended: `sms:+1555` becomes `sms__1555-<hash>`.
Return a valid id from `sessionId()` to use it unchanged.

Transcripts are kept in `mountChannels(agent, channels, { store })`: a
`SessionStore` or `{ sessions, checkpoints }` such as a `SqliteStore` (pass the
one you gave `createAgent({ store })`). Without `store`, the handler keeps them
in memory.

## Approvals and questions

When a turn pauses on a tool that needs approval, or on an
[`ask_question`](approvals.md) call, the handler calls `onApproval` (by default,
`reply` with a prompt such as `Approve send_email {"to":"sam@example.com"}?
(approval id: ...)`). Decide it in one of two ways; the continuation goes back
through the same channel's `reply` (or `onApproval` again, if it pauses again):

- `handler.resolveApproval({ id, approved, note? })` or
  `handler.resolveApproval({ id, answer })` from your code, e.g. a surface's
  button callback.
- `POST <basePath>/<name>/approvals/<id>` with `{ approved, note? }` or
  `{ answer }`. The channel's `verify` runs first; an id the channel did not
  pause on gets 404.

```ts
import { createAgent, defineChannel, mountChannels } from '@loushy/build-ai-agent';

const agent = createAgent({ instructions: 'You are helpful.', provider, askQuestion: true });

const chat = defineChannel({
  name: 'chat',
  async parse(req) {
    const { room, text } = JSON.parse(req.text) as { room: string; text: string };
    return { sessionKey: room, input: text, replyTo: room };
  },
  async reply({ inbound, text }) {
    console.log(`to room ${String(inbound.replyTo)}: ${text}`);
  },
  async onApproval({ approval }) {
    console.log(`[Approve] [Reject] buttons for ${approval.toolName}, id ${approval.id}`);
  },
});

const channels = mountChannels(agent, [chat]);
// Later, from the button's callback:
await channels.resolveApproval({ id: 'the-approval-id', approved: true });
```

## Built-in channels

| Channel | Request | Response |
| ------- | ------- | -------- |
| `httpChannel({ name?, verify? })` | JSON `{ sessionKey, input }` (`input` a string or content parts); anything else is a 400 | `200 { sessionId, text, finishReason }`; when paused, `approval` too and `text` is the prompt |
| `webhookChannel({ secret?, auth?, name? })` | The JSON body's `input` string, or the whole body; a one-shot session unless the body has a `sessionKey` | `200` with the turn's `ExecutionResult`, as `WebhookTriggerAdapter` answers |

`webhookChannel({ secret })` checks an HMAC-SHA256 signature of the raw body in
`x-signature-256: sha256=<hex>`; `auth` takes any
[webhook auth](api-overview.md#webhook-authentication) (HMAC options with
replay protection, bearer token, custom). The checks and the generic 401 are
the ones `WebhookTriggerAdapter` uses.

```ts
import { createAgent, httpChannel, mountChannels, webhookChannel } from '@loushy/build-ai-agent';

const agent = createAgent({ instructions: 'You are helpful.', provider });

const handler = mountChannels(agent, [
  httpChannel({ verify: async (req) => req.headers.authorization === `Bearer ${process.env.API_TOKEN}` }),
  webhookChannel({ secret: process.env.WEBHOOK_SECRET ?? '' }),
]);
```

Slack and Discord channels are planned (LOU-P5, LOU-P6), as are channels
loaded from an agent directory's `channels/*.ts` (LOU-P7.2). Until then, use
`SlackTriggerAdapter` and `verifySlackSignature()` (see
[Triggers](api-overview.md#triggers)), or write a channel with `defineChannel()`.
