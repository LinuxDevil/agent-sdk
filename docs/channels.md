# Channels

A **channel** connects an agent to one surface: a JSON API, a webhook, a chat
app. It says how an inbound request is authenticated, which conversation it
belongs to, and how the agent's reply (or an approval it pauses on) goes back
to the surface. `mountChannels()` serves your channels behind one `(req, res)`
handler and runs every request the same way:

```text
POST <basePath>/<name>  ->  verify  ->  parse  ->  session turn  ->  reply (or onApproval)
```

Channels replace the [trigger adapters](triggers.md), which are deprecated
(`WebhookTriggerAdapter` uses `webhookChannel()` for its auth and parsing).
Channels add what triggers lack: each conversation on the surface is
a [session](sessions.md), and approvals and questions go back to the surface.

On a Fetch host such as a Cloudflare Worker, `mountFetchChannels()` serves the
same routes with a `Request` in and a `Response` out (and the host's
`ctx.waitUntil` keeps a turn alive past an acknowledged webhook);
`lousho build --target=cloudflare-worker` mounts an agent directory's
`channels/` under `/channels` with it.

## Quick start

`httpChannel()` is the reference channel: `{ sessionKey, input }` in, JSON out.

```ts
import * as http from 'node:http';
import { createAgent, createMockProvider, httpChannel, mountChannels } from '@lousho/build-ai-agent';

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
written) for any other route, like the `/chat` routes of `lousho dev`, so you
can mount it next to your own routes.

## The contract

`defineChannel({ ... })` checks the name and returns the definition:

| Field | Description |
| ----- | ----------- |
| `name` | Route segment: `POST <basePath>/<name>`. Letters, digits, `_` and `-`. |
| `verify(req)` | Optional. Authenticate the request (a signature, a token). Return `true`/`false` or `{ ok, reason? }`; `false` answers `401 {"error":"Unauthorized"}` before anything is parsed or run. |
| `parse(req, respond, ctx)` | The message: `{ sessionKey, input, metadata?, principal?, replyTo, event? }`; `{ decision: { id, approved?, note?, answer? } }` to resolve a pause this channel's turn stopped on (a button click); or `null` to acknowledge the request without a turn (a bot's own message, a retry). Call `respond(status, body)` to answer before the turn runs (a surface with a short timeout, a handshake). |
| `reply(ctx)` | Deliver the reply: `ctx.text`, plus `inbound`, `sessionId`, `result`, `events`, `approval`, and `respond(status, body)` while the request is still open. |
| `onApproval(ctx)` | Optional. Render a pause (buttons, a form). Default: `reply` with a text prompt in `ctx.text` and the request in `ctx.approval`. |
| `onError(error, { channel, stage, sessionId? })` | Optional. Receives failures after the request was already acknowledged (a reply that could not be delivered, a failed turn or approval continuation). Default: `mountChannels({ onError })`, else `console.error` with the channel, stage, session id and SDK error code (never a token). A failed turn also tells the user "Sorry, that request failed." in the conversation (best effort). |
| `stream` | Optional. `true` calls `reply` with `partial: true` and the text so far as the model writes, then once more with the final text. |
| `sessionId(inbound)` | Optional. The session for a message. Default: `` `${name}:${sessionKey}` ``. |

`metadata` is passed to the turn as `send()`'s `metadata` (memory scope
functions, `model` / `instructions` / `tools` functions see it); `principal`
is the turn's verified caller, passed where `send()`'s `principal` goes. Set
`principal` only from data `verify` vouched for.

`ctx` (`ChannelContext`) lets `parse` ask the host instead of keeping state: `ctx.approval(id)` (the pending call), `ctx.sessionId(key)`, `ctx.hasSession(key)` (a session for that key was saved in the `store`) and `ctx.pendingQuestion(key)` (the id of the `ask_question` that key's session waits on, or `undefined`; it also finds a question asked before a restart when sessions, checkpoints and approvals are in durable stores, and binds it to the session so the answer's turn joins the transcript). Call `pendingQuestion` only for a message you return as the answer, `{ decision: { id, answer: text }, inbound }`: the id is handed out once until that answer has run. A `{ decision }` may carry `inbound` (the conversation as the click itself names it, so a pause survives a restart) and `approver` (who decided; passed to `mountChannels({ onDecision })` for your audit log).

`req` is a framework-free `ChannelRequest`: `method`, `url`, `headers`
(lower-case names), `rawBody` (the exact bytes: verify signatures over these,
never over re-serialized JSON), `text` and `native` (the host's request).

A reply that does not call `respond` is followed by `200 {"ok":true}`; a surface
that delivers replies out of band (posting to a chat API) only needs to
acknowledge the request. An error thrown by `parse` answers 400 for a
`SyntaxError` (bad JSON) and 500 otherwise; a body over 1MB gets 413.

```ts
import { createAgent, defineChannel, mountChannels } from '@lousho/build-ai-agent';

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
import { createAgent, defineChannel, mountChannels } from '@lousho/build-ai-agent';

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
| `webhookChannel({ secret?, auth?, name?, principal? })` | The JSON body's `input` string, or the whole body; a one-shot session unless the body has a `sessionKey` | `200` with the turn's `ExecutionResult`, as `WebhookTriggerAdapter` answers |
| `slackChannel({ signingSecret, botToken, name?, fetch?, approvers?, onError? })` | Slack Events API and interactivity requests (see [Slack](#slack)) | `200` at once; replies are posted in the Slack thread |
| `discordChannel({ publicKey, applicationId, botToken?, name?, fetch?, approvers?, onError? })` | Discord slash-command and button interactions (see [Discord](#discord)) | Deferred ack at once; the reply edits the original response |
| `telegramChannel({ botToken, secretToken, botUsername?, name?, fetch?, approvers?, onError? })` | Telegram bot webhook updates: messages and inline-keyboard taps (see [Telegram](#telegram)) | `200` at once; replies are sent with `sendMessage` as plain text |
| `githubChannel({ webhookSecret, botName, token?, app?, name?, apiUrl?, fetch?, triggers?, approvers?, onError? })` | GitHub issue, pull-request and review comments that mention `@<botName>` (see [GitHub](#github)) | `200` at once; replies are posted as comments in the same thread |
| `teamsChannel({ appId, appPassword, tenantId?, name?, fetch?, approvers?, onError? })` | Microsoft Teams messages and Adaptive Card button presses from an Azure Bot (see [Microsoft Teams](#microsoft-teams)) | `200` at once; replies are posted through the Bot Framework Connector as Markdown |

`webhookChannel({ secret })` checks an HMAC-SHA256 signature of the raw body in
`x-signature-256: sha256=<hex>`; `auth` takes any
[webhook auth](triggers.md#webhook-authentication) (HMAC options with
replay protection, bearer token, custom). The checks and the generic 401 are
the ones `WebhookTriggerAdapter` uses. `principal` is a
`(body, req) => Principal | undefined` that names the caller of the turn from
the verified request (the alerting system that sent the hook, an integration
user); `body` is the parsed JSON body, `undefined` when it is not JSON.

```ts
import { createAgent, httpChannel, mountChannels, webhookChannel } from '@lousho/build-ai-agent';

const agent = createAgent({ instructions: 'You are helpful.', provider });

const handler = mountChannels(agent, [
  httpChannel({ verify: async (req) => req.headers.authorization === `Bearer ${process.env.API_TOKEN}` }),
  webhookChannel({ secret: process.env.WEBHOOK_SECRET ?? '' }),
]);
```

## In an agent directory

An [agent directory](./agent-directories.md#channels) can keep its channels in
`channels/*.ts`, one default-exported channel per file. The served route is
`POST /channels/<name>`, with `<name>` the channel's own `name`; the file name
applies only to an export that has none — and every built-in factory sets one
(`webhookChannel()` → `webhook`, `slackChannel()` → `slack`, ...), so a
`channels/support.ts` that exports `webhookChannel()` is served at
`/channels/webhook`, not `/channels/support`. `resolveAgentDir()` returns them
as `channels`, and the node server `lousho build` emits mounts them
(`createDeployedServer(agent, { channels })`, an internal helper).

## Who may approve (Slack and Discord)

Both channels take `approvers`: a list of platform user ids, or a function
`(user: { id, name?, roles? }, { toolName, input, sessionId, principal? }) => boolean | Promise<boolean>`
(Discord fills `roles` with the member's role ids; `principal` is the sender
whose turn paused). The user who clicks is recorded as the approver
(`ctx.approval.by` in the tool, see
[auth](./auth.md#who-approved)); the tool still runs for the sender. A click from anyone else
does not decide the approval: the user gets an ephemeral "not allowed" message
and the approval stays pending.

**Security note.** Without `approvers`, only the user who started the turn (the
message author on Slack, the command's user on Discord) may approve. In
earlier versions anyone who could see the message could; `approvers: () => true`
restores that, which you should only do in a private channel. A function
`approvers` sees the pending call after a restart too: `ctx.approval(id)` asks
the durable approval store when this process did not pause on the id, so it
decides the same way it did before. Only with a process-local approval store
(the default `InMemoryApprovalStore` - then nothing survives a restart anyway)
does it still fail closed. Answers to an `ask_question` are not restricted: the next message (Slack)
or `/ask` (Discord) in the conversation is the answer. Who decided goes to
`mountChannels(agent, channels, { onDecision({ approver, decision, sessionId, channel }) {} })`.
The Telegram channel takes the same `approvers` (Telegram user ids as strings; a
function gets `{ id, name }`, with `name` the username or first name).

Failures after the acknowledgment go to `onError` (option of the channel, or of
`mountChannels`); see the contract above.

## Slack

`slackChannel({ signingSecret, botToken, name?, fetch? })` connects a Slack app.
Each Slack thread is one session: a mention of the bot starts (or continues)
the session of its thread, keyed by team, channel and the thread's root `ts`;
later messages in a thread that already has a session continue it without a
mention (the session store is asked, so this survives a restart). A direct
message to the bot starts a session keyed on the DM channel. Replies are posted in the thread with `chat.postMessage` (plain
`fetch`, no Slack SDK; pass `fetch` to inject one in tests).

- Every request's signature is checked (`v0` HMAC-SHA256 with Web Crypto,
  five-minute replay window); a failure answers 401.
- The request is answered right away (`200`, or the `url_verification`
  challenge) and the turn runs after the response, within Slack's 3-second
  limit.
- Retries (`X-Slack-Retry-Num`), bot messages (including the bot's own) and
  the `message` copy of a mention are acknowledged and skipped, so a turn
  never runs twice.
- A tool approval is posted in the thread with **Approve** and **Deny**
  buttons; the click resumes the session and the continuation is posted in the
  thread. The clicked message is replaced with the outcome ("Approved by @user"),
  so its buttons disappear. The click carries its channel, thread and the user who
  may decide, so it works after a restart. An `ask_question` is posted as text, and the next message in the
  thread is the answer, also after a restart (see below).

Set up the app at [api.slack.com/apps](https://api.slack.com/apps):

1. **OAuth & Permissions**: bot token scopes `app_mentions:read`, `chat:write`,
   and `channels:history` (plus `groups:history` for private channels) for
   follow-ups without a mention, and `im:history` for direct messages. Install the app and copy the bot token
   (`xoxb-...`).
2. **Event Subscriptions**: Request URL `https://<host>/channels/slack`; bot
   events `app_mention` and `message.channels` (`message.groups` for private
   channels), and `message.im` for direct messages (also enable **Messages Tab**
   in App Home so users can write to the bot).
3. **Interactivity & Shortcuts**: Request URL `https://<host>/channels/slack`
   (the same route).
4. **Basic Information**: copy the signing secret.

```ts
import * as http from 'node:http';
import { createAgent, mountChannels, slackChannel } from '@lousho/build-ai-agent';

const agent = createAgent({ instructions: 'You are a helpful Slack bot.', provider });

const channels = mountChannels(agent, [
  slackChannel({
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
    botToken: process.env.SLACK_BOT_TOKEN ?? '',
  }),
]);

http.createServer((req, res) => {
  void channels(req, res).then((handled) => handled || res.writeHead(404).end());
}).listen(3000);
```

Which threads are active comes from the `store` you pass `mountChannels()`.
Pending approvals are resolved from the click itself. A pending `ask_question`
survives a restart when the session, its checkpoints and the approvals are in
durable stores (for example `mountChannels(agent, channels, { store: sqlite })`
with a `SqliteStore`, and the agent's `approvalStore`): the next message in the
thread is still the answer, the turn continues, and the question, the answer
and the reply are appended to the session transcript. A message in a thread
whose session waits on a tool approval does not decide it; only the buttons
do. A button click after a restart is bound to the thread's session first -
the click must name a thread whose checkpointed turn waits on exactly that
approval - so the continuation is appended to the session transcript, a
replayed click does not run the tool twice, and a click in another thread is
refused.

## Discord

`discordChannel({ publicKey, applicationId, botToken?, name?, fetch? })`
connects a Discord application over the HTTP Interactions endpoint (no gateway
connection, no Discord library; Web Crypto and `fetch` only, so it also runs on
Workers). The expected command is `/ask prompt:<text>`: one string option, and
the `prompt` option (or the first string option) is the message.

- Every request's `X-Signature-Ed25519` / `X-Signature-Timestamp` is verified
  over `timestamp + body`; a missing or bad signature answers 401, as Discord
  requires. `PING` is answered with `PONG`.
- A command is acknowledged at once with a deferred response (within Discord's
  3-second limit); the reply then edits the original response
  (`PATCH /webhooks/{applicationId}/{token}/messages/@original`). Text over
  2000 characters continues in follow-up messages.
- Commands in the same channel share one session, keyed by guild and channel
  (and the thread, in a thread).
- A tool approval is posted with **Approve** and **Deny** buttons (only
  `approvers`, by default the command's user, may click them); the click
  resumes the session and the continuation is a follow-up message. The click
  carries the conversation, so it works after a restart. An
  `ask_question` is posted as text, and the next `/ask` in that channel is the
  answer, also after a restart (see below).
- Interaction tokens last 15 minutes, so a reply (or a click) later than that
  fails. `botToken` is reserved for bot REST calls; replies need only the
  interaction token.

Set up the application at
[discord.com/developers/applications](https://discord.com/developers/applications):

1. **General Information**: copy the application id and the public key.
2. **Interactions Endpoint URL**: `https://<host>/channels/discord` (Discord
   sends a signed `PING` when you save it).
3. **Installation**: the `applications.commands` scope is enough (add `bot`
   only if you also want the bot user in the server).
4. Register the command once (a guild command appears immediately; use
   `/applications/{id}/commands` for a global one):

```sh
curl -X POST "https://discord.com/api/v10/applications/$APP_ID/guilds/$GUILD_ID/commands"   -H "Authorization: Bot $BOT_TOKEN" -H "Content-Type: application/json"   -d '{"name":"ask","description":"Ask the agent","options":[{"type":3,"name":"prompt","description":"Your message","required":true}]}'
```

```ts
import * as http from 'node:http';
import { createAgent, discordChannel, mountChannels } from '@lousho/build-ai-agent';

const agent = createAgent({ instructions: 'You are a helpful Discord bot.', provider });

const channels = mountChannels(agent, [
  discordChannel({
    publicKey: process.env.DISCORD_PUBLIC_KEY ?? '',
    applicationId: process.env.DISCORD_APPLICATION_ID ?? '',
  }),
]);

http.createServer((req, res) => {
  void channels(req, res).then((handled) => handled || res.writeHead(404).end());
}).listen(3000);
```

Pending approvals are resolved from the button click and the approval store. As
on Slack, a pending `ask_question` survives a restart given durable stores for
sessions, checkpoints and approvals: the next `/ask` in the channel is the
answer and the continued turn is appended to the session transcript. A button
click after a restart names its conversation, so it is bound to that session
before the approval is resolved - the continuation joins its transcript, and a
stale or copied click decides nothing.

An [agent directory](./agent-directories.md)'s `channels/*.ts` files are loaded
as channels too, and the node server mounts them. `SlackTriggerAdapter` (see [Triggers](triggers.md)), which replies
through an incoming webhook, is deprecated: use `slackChannel()`. `verifySlackSignature()` is not deprecated.

## Telegram

`telegramChannel({ botToken, secretToken, botUsername?, name?, fetch?, approvers?, onError? })`
puts an agent behind a Telegram bot over webhooks (no long polling, no Telegram
library; Web Crypto and `fetch` only, so it also runs on Workers).

- Every request's `X-Telegram-Bot-Api-Secret-Token` header is compared with
  `secretToken` in constant time; a missing or wrong value answers 401. The
  channel has no unauthenticated mode, so always pass `secret_token` to
  `setWebhook`.
- The update is acknowledged with `200` at once and the turn runs after, so
  Telegram does not retry the webhook.
- In a private chat every text message (or photo or document caption) is a
  message to the agent. In a group or supergroup only a `/ask` command (or
  `/ask@<botUsername>`), a message containing `@<botUsername>`, or a reply to
  one of the bot's own messages wakes the bot; the command and the mention are
  removed from the text and every other message is ignored. Messages from bots
  are ignored. Set `botUsername` (without `@`) to use the group rules that need
  it.
- One session per chat, and one per topic in a forum supergroup. Replies go to
  the same chat and topic, as a reply to the triggering message.
- Replies are plain text (no `parse_mode`), so Markdown from the model cannot
  make Telegram reject the message. Text over 4096 characters is split at line
  breaks into several messages.
- A tool approval is posted with an inline keyboard of **Approve** and
  **Deny**. Only `approvers` (default: the user whose message started the turn)
  may tap them; anyone else gets an alert and the approval stays pending. A tap
  answers the callback, edits the message to append "Approved by ..." or
  "Denied by ..." and remove the keyboard, and the continuation is sent as a new
  message. The tap carries its chat, so it works after a restart. Telegram
  limits `callback_data` to 64 bytes: it holds `a:` or `d:`, the starter's user
  id and the approval id (about 55 bytes). If it would be longer, the starter is
  left out, and then only an `approvers` list or function can approve (the
  default refuses everyone).
- An `ask_question` is sent as text with `force_reply`, and the next message in
  the chat is the answer (in a group it has to be addressed to the bot, which
  replying to the question does).
- Attachments are not read yet: only the text or caption reaches the agent.

Set the bot up with [@BotFather](https://t.me/BotFather):

1. Send `/newbot`, choose a name and a username, and copy the bot token. For
   use in groups, `/setprivacy` decides whether the bot sees every message;
   `/ask`, mentions and replies work either way.
2. Pick a random secret token (1 to 256 characters from `A-Z`, `a-z`, `0-9`,
   `_` and `-`).
3. Register the webhook once, with the bot token in the URL and the secret
   token in the body (keep both out of shell history and logs):

```sh
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" -H "Content-Type: application/json" -d '{"url":"https://<host>/channels/telegram","secret_token":"'"$TELEGRAM_SECRET_TOKEN"'","allowed_updates":["message","callback_query"]}'
```

```ts
import * as http from 'node:http';
import { createAgent, mountChannels, telegramChannel } from '@lousho/build-ai-agent';

const agent = createAgent({ instructions: 'You are a helpful Telegram bot.', provider });

const channels = mountChannels(agent, [
  telegramChannel({
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    secretToken: process.env.TELEGRAM_SECRET_TOKEN ?? '',
    botUsername: 'my_agent_bot',
  }),
]);

http.createServer((req, res) => {
  void channels(req, res).then((handled) => handled || res.writeHead(404).end());
}).listen(3000);
```

The bot token is part of every Bot API URL, so the channel builds its error
messages from the method name and status only: the token never reaches
`onError` or the default log line.

Pending approvals are resolved from the tap and the approval store. As on Slack
and Discord, a pending `ask_question` survives a restart given durable stores
for sessions, checkpoints and approvals: the next message in the chat is the
answer and the continued turn is appended to the session transcript. As with a
button click on the other channels, a tap after a restart is checked against
the chat session's checkpointed turn, so the continuation joins the transcript
and a replayed tap does not run the tool twice.

## GitHub

`githubChannel({ webhookSecret, botName, token?, app?, name?, apiUrl?, fetch?, triggers?, approvers?, onError? })`
lets people summon an agent with `@<botName>` in a GitHub issue, pull-request
or review comment; the agent answers with a comment in the same thread. It reads
the webhooks of a GitHub App (or of one repository) and posts through the REST
API with `fetch` and Web Crypto only (no `node:*` import and no GitHub library),
so it also runs on Workers.

- Every request's `X-Hub-Signature-256` header is checked against the raw body
  with `webhookSecret` (HMAC-SHA256, compared in constant time) before the body
  is parsed; a missing or wrong signature answers 401. The channel has no
  unauthenticated mode.
- The webhook is acknowledged with `200` at once and the turn runs after: GitHub
  waits 10 seconds and does not retry, and a slow reply is posted as a new
  comment. A `ping` is acknowledged without a turn.
- A comment on an issue, on a pull request (the conversation tab) or a review
  comment (on a line of the diff) that contains `@<botName>` as a whole word
  (case-insensitive) starts a turn, with the mention removed from the text. Once
  a thread has a session, every later comment in it is a follow-up and needs no
  mention. Edited and deleted comments, comments by bots (`user.type` is `Bot`),
  by `<botName>[bot]`, by `botLogin` and any comment the channel itself posted
  are ignored, so the agent never answers itself. Other events (issues opened,
  pushes, reactions, check runs) are ignored.
- One session per issue or pull request (`<owner>/<repo>#<number>`), and one
  per review thread (a review comment and the replies under it).
- The reply is a new comment: a timeline comment on the issue or pull request,
  or a reply in the review thread. Text over 60,000 characters (GitHub's limit
  is 65,536) is split at line breaks into several comments. Every comment
  carries a hidden marker (an HTML comment) that the channel recognizes.
- A tool approval is a comment with the tool and its arguments in a fenced block
  and the line "Reply `/approve <id>` or `/deny <id>`.". A comment whose
  **first line** is `/approve <id>` or `/deny <id>` (any case) decides it; lines
  after the first are a note for the model. A quote of the prompt, or the
  command anywhere but the first line, decides nothing. The channel answers
  "Approved by @login." or "Denied by @login." and the run continues with a new
  comment. The id is the pending approval's, so an old command (a redelivered
  webhook, or the comment of an approval already decided) cannot decide a later
  approval.
- An `ask_question` is posted as a comment and the next comment in that thread is
  the answer (no mention needed, from anyone `triggers` allows). A pending
  question survives a restart given durable stores for sessions, checkpoints
  and approvals, as on Slack and Discord; the cost is one store lookup for each
  comment that is not a mention in a thread without a session.

**Security note.** A GitHub comment is text written by anyone who can comment on
the repository, which on a public repository is everybody. It is untrusted input
to the agent, like any user message, and can try to steer it (prompt
injection); the issue and pull-request text it refers to is just as untrusted.
Give the agent only tools whose worst use you accept, and keep `needsApproval`
on the ones that write or spend. Two options say who is trusted, and both are
explicit:

- `triggers` (default: everyone who can comment) says who may start a turn or
  answer a question: a list of logins, or a function
  `({ login, association }) => boolean`. On a public repository, restrict it
  (for example to `association` `OWNER`, `MEMBER` or `COLLABORATOR`) unless you
  want strangers to spend your model credits.
- `approvers` says who may `/approve` and `/deny`, and it **defaults closed**:
  without it only a commenter whose `author_association` is `OWNER`, `MEMBER` or
  `COLLABORATOR` may decide. This differs from Slack and Discord on purpose: a
  GitHub thread is visible to everyone who can read the repository, and the
  person who started the turn may be anyone, so the author of the request is not
  trusted to approve it. A refused command gets "@login is not allowed to
  approve this request." and the approval stays pending. With a list of logins
  (case-insensitive), only those users decide, whatever their association. With
  a function `(user, { toolName, input, sessionId }) => boolean`, `user.id` is
  the login and `user.roles` is `[author_association]`.

The association is read from the webhook of the command comment itself, so the
decision is based on what GitHub reported when that comment was written (the
request is authentic because of the signature), not on the membership the
commenter had when the approval was requested: a collaborator who was removed
before posting `/approve` is refused. It is a snapshot taken at the command, not
a live permission check; if a revocation must take effect inside that window,
use `approvers` with a function that asks the GitHub API (for example the
collaborator permission) before it returns `true`. A function `approvers`, as on
the other channels, sees the pending call after a restart too (the durable
approval store is asked), and fails closed only with a process-local approval
store.

Set up a GitHub App:

1. Create the app (Settings, Developer settings, GitHub Apps, New GitHub App).
   Under Webhook, set the URL to `https://<host>/channels/github`, keep it
   active, and choose a long random secret (this is `webhookSecret`).
2. Permissions: Issues read and write, Pull requests read and write. Subscribe
   to the events **Issue comment** and **Pull request review comment**.
3. Generate a private key (GitHub downloads it as a PKCS#1 PEM, `BEGIN RSA PRIVATE KEY`;
   PKCS#8 works too) and note the App ID. Install the app on the repositories it
   should answer in. Every webhook names its installation, and the channel
   exchanges a signed JWT for an installation token for each one and caches it
   until 5 minutes before it expires.
4. `botName` is the app's slug: `@my-agent` in a comment mentions the app
   `my-agent`, which posts as `my-agent[bot]`.

For a single repository you can skip the app: add a repository webhook
(content type `application/json`, the same two events, the same URL and secret)
and pass `token`, a fine-grained personal access token with Issues and Pull
requests read and write on that repository (or a function that returns a
token). Replies are then posted as the token's user, so also pass `botLogin`
with that user's login. Without it, only the channel's hidden marker stops the
agent from answering its own comments.

```ts
import * as http from 'node:http';
import { createAgent, githubChannel, mountChannels } from '@lousho/build-ai-agent';

const agent = createAgent({ instructions: 'You answer questions about this repository.', provider });

const channels = mountChannels(agent, [
  githubChannel({
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? '',
    botName: 'my-agent',
    app: { appId: process.env.GITHUB_APP_ID ?? '', privateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? '' },
    triggers: ({ association }) => ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association),
  }),
]);

http.createServer((req, res) => {
  void channels(req, res).then((handled) => handled || res.writeHead(404).end());
}).listen(3000);
```

`apiUrl` points the channel at GitHub Enterprise Server
(`https://<host>/api/v3`). The token, the private key and the JWT are never put
in an error message or log line: a failed call is reported to `onError` with the
call and the HTTP status only (`LOUSHO_CHANNEL_REQUEST_FAILED`).

Pending approvals are resolved from the command comment and the approval store.
A pending `ask_question` is kept in memory until the next comment, and survives
a restart given durable stores, as on the other channels. After a restart the
command names its thread, so - given durable checkpoints - it is bound to that
thread's session before the approval is resolved: the continuation is appended
to the session transcript, and an id the thread is not waiting on (decided
already, or the approval of another thread) fails with the generic "Sorry,
that request failed." comment.

## Microsoft Teams

`teamsChannel({ appId, appPassword, tenantId?, name?, fetch?, approvers?, onError? })`
puts an agent behind an Azure Bot in Microsoft Teams: personal chats and
channel mentions start or continue a session, replies go back through the Bot
Framework Connector, and a tool approval is an Adaptive Card with Approve and
Deny buttons. It uses `fetch` and Web Crypto only (no `node:*` import and no Bot
Framework library), so it also runs on Workers.

- Every request must carry a Bot Framework token in `Authorization: Bearer`. It
  is verified before the body is parsed: an RS256 signature checked against
  the key set that the fixed Bot Framework OpenID metadata
  (`https://login.botframework.com/v1/.well-known/openidconfiguration`) points
  to (cached, never taken from a URL inside the token), the issuer
  `https://api.botframework.com`, the audience `appId` and a 5-minute clock
  tolerance. The token's `serviceurl` claim must also equal the activity's
  `serviceUrl`, so a valid token for one service URL cannot be replayed to make
  the bot post somewhere else. Any failure answers 401. The channel has no
  unauthenticated mode, and the Bot Framework emulator without authentication
  is not supported.
- The activity is acknowledged with `200` at once and the turn runs after.
  Only `message` activities reach the agent; `conversationUpdate`, `typing`,
  `invoke` and the bot's own messages are ignored.
- A personal chat always starts or continues a session. In a group chat or a
  channel only a message that `@mentions` the bot does; the mention is removed
  from the text and every other message is ignored.
- One session per conversation (`conversation.id`; in a Teams channel it
  includes the thread's root message, so each thread is its own session). The
  sender (`from.aadObjectId`, else `from.id`) is the run's `principal`
  (`authenticator: 'teams'`, `issuer`: the tenant), as on the other channels.
- Replies are Markdown posted to `{serviceUrl}/v3/conversations/{id}/activities/{replyToId}`,
  with the `serviceUrl` the token vouched for (`https` only). Text over 25,000
  characters is split at line breaks. The outbound access token comes from the
  client-credentials flow with `appId` and `appPassword` and is cached until 5
  minutes before it expires.
- A tool approval is an Adaptive Card (version 1.4) with the tool, its arguments
  (cut at 2,000 characters) and two `Action.Submit` buttons. Only `approvers`
  (Teams user ids as in `from.id`, or a function) can use them; by default only
  the user who started the turn. Anyone else gets "You are not allowed to
  approve this request." and the approval stays pending. A press replaces the
  card with "Approved by <name>." or "Denied by <name>." (no buttons) and the run
  continues with a new message. A button carries the conversation it was posted
  in, and a press whose conversation differs (a copied reference) decides
  nothing; the approval id is the pending approval's, so an old card cannot
  decide a later approval, and a card already used does nothing, also after a
  restart.
- An `ask_question` is posted as text and the next message in the conversation
  is the answer. A pending question survives a restart given durable stores for
  sessions, checkpoints and approvals, as on Slack and Discord.

Set up the bot:

1. Create an Azure Bot (single-tenant or multi-tenant) and note its Microsoft
   App ID (`appId`). Under Configuration, set the messaging endpoint to
   `https://<host>/channels/teams`.
2. Under Manage Password, create a client secret (`appPassword`). For a
   single-tenant bot also pass `tenantId` (the secret is then requested from
   your tenant).
3. Under Channels, enable Microsoft Teams.
4. Create a Teams app manifest whose `bots` entry has `botId` set to the App ID
   and the scopes you want (`personal`, `team`, `groupChat`), and install it.

```ts
import * as http from 'node:http';
import { createAgent, mountChannels, teamsChannel } from '@lousho/build-ai-agent';

const agent = createAgent({ instructions: 'You help the team with questions.', provider });

const channels = mountChannels(agent, [
  teamsChannel({
    appId: process.env.MICROSOFT_APP_ID ?? '',
    appPassword: process.env.MICROSOFT_APP_PASSWORD ?? '',
    tenantId: process.env.MICROSOFT_TENANT_ID,
  }),
]);

http.createServer((req, res) => {
  void channels(req, res).then((handled) => handled || res.writeHead(404).end());
}).listen(3000);
```

The app password and the access token are never put in an error message or log
line: a failed call is reported to `onError` with the call and the HTTP status
only (`LOUSHO_CHANNEL_REQUEST_FAILED`). A press on a card works on a restarted
process, because it names the conversation and the approval itself; given
durable checkpoints the press is bound to that session's pending turn first,
so the continuation is appended to the session transcript and a press a
session is not waiting on decides nothing.
