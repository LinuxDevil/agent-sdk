# Triggers

A trigger adapter turns one wake-up mechanism into an agent run: an inbound webhook, a clock, or a Slack event. **`WebhookTriggerAdapter`, `SlackTriggerAdapter` and `CronTriggerAdapter` are deprecated** and will be removed in a future major version: use `webhookChannel()`, `slackChannel()` and `defineSchedule()` instead (each section below has a migration snippet). `TriggerAdapter` and `TriggerRegistry` are the extension point and are not deprecated. Import them from the `@lousho/build-ai-agent/triggers` subpath: `WebhookTriggerAdapter`, `SlackTriggerAdapter`, `CronTriggerAdapter` and `TriggerRegistry`. Wire any of them with `listen(agent, onEvent)`, where `onEvent` runs the agent, and call `stop()` on the returned handle to shut the adapter down.

```ts
import { createAgent, createMockProvider } from '@lousho/build-ai-agent';
import { CronTriggerAdapter } from '@lousho/build-ai-agent/triggers';

const agent = createAgent({ prompt: 'You are helpful.', provider: createMockProvider() });

const cron = new CronTriggerAdapter({
  intervalMs: 60_000,
  input: 'Check the queue',
  onResult: (result, error) => console.log(error ?? result?.text),
});
const handle = cron.listen(agent, (input) => agent.send(input));

// Later, on shutdown: clear the timer (a webhook adapter closes its HTTP listener).
await handle.stop();
```

## Choosing between triggers, channels and schedules

| | Use it for | Entry points |
|---|---|---|
| Triggers | The extension point for your own wake-up mechanism. The three built-in adapters are deprecated. | `TriggerAdapter`, `TriggerRegistry` (deprecated: `WebhookTriggerAdapter`, `SlackTriggerAdapter`, `CronTriggerAdapter`) |
| [Channels](./channels.md) | A surface people talk to. Each conversation maps to a session, and approvals and questions the agent pauses on go back to the surface. | `defineChannel()`, `mountChannels()`, `httpChannel()`, `webhookChannel()` |
| [Schedules](./schedules.md) | Cron for agent directories and the node server, with support on the deployed targets. | `defineSchedule()`, `startSchedules()` |

Each deprecated adapter has a replacement that is wired into sessions, approvals, agent directories and `lousho build`: Slack is `slackChannel()`, webhooks are `webhookChannel()` (both mounted with `mountChannels()`), and cron is `defineSchedule()` with `startSchedules()`. The deprecated adapters keep working until they are removed.

## The TriggerAdapter interface

```text
interface TriggerAdapter<TChannel = unknown> {
  type: string;
  listen(
    agent: RunnableAgent, // { send(message: string): Promise<ExecutionResult> }
    onEvent: (input: string, context: TriggerContext) => Promise<ExecutionResult>
  ): TriggerHandle; // { stop(): Promise<void> | void }
  reply?(channel: TChannel, message: string): Promise<void>;
}
```

`listen` takes both `agent` and `onEvent` on purpose. `agent` is the plain "prompt in, text out" surface, and `onEvent` is the entry point the adapter calls when its trigger fires: a simple caller passes `(input) => agent.send(input)`, while a caller with checkpointing, approval gates or abort control passes an `onEvent` that wraps all of that.

Reply semantics differ per adapter. A webhook writes the result you return as the HTTP response, so it has no `reply()`. A cron has no caller waiting, so it hands the result to its `onResult` option. Slack posts the answer back through `reply()`.

Write your own adapter by returning a handle from `listen`:

```ts
import { createAgent, createMockProvider } from '@lousho/build-ai-agent';
import type { TriggerAdapter } from '@lousho/build-ai-agent/triggers';

const agent = createAgent({ prompt: 'You are helpful.', provider: createMockProvider() });

const everyTenSeconds: TriggerAdapter = {
  type: 'ten-seconds',
  listen(_agent, onEvent) {
    const timer = setInterval(() => void onEvent('tick', { firedAt: new Date() }), 10_000);
    return { stop: () => clearInterval(timer) };
  },
};

const handle = everyTenSeconds.listen(agent, (input) => agent.send(input));
handle.stop();
```

`TriggerRegistry` keeps adapters by name: `register(name, adapter)`, `registerMany()`, `get()`, `has()`, `list()`, `getAll()`, `unregister()`, `clear()` and `size()`. `globalTriggerRegistry` is a shared instance.

## Webhook

### Webhook authentication

**Deprecated.** `WebhookTriggerAdapter` is replaced by `webhookChannel()` mounted with `mountChannels()` (see [Channels](./channels.md)), which takes the same `auth` option and adds sessions and approvals. The `WebhookAuth` shapes below stay and are the reference for `webhookChannel({ auth })`.

```ts
import { createAgent, createMockProvider, mountChannels, webhookChannel } from '@lousho/build-ai-agent';

const agent = createAgent({ instructions: 'You are helpful.', provider: createMockProvider() });

// POST /webhook, authenticated with an HMAC of the raw body; serve it from any node server.
const handler = mountChannels(agent, [
  webhookChannel({ auth: { type: 'hmac', secret: process.env.WEBHOOK_SECRET ?? '' } }),
]);
```

`WebhookTriggerAdapter` starts an HTTP server. **Always set `auth` for a
webhook that is reachable from outside your machine**: without it, anyone who
can reach the port can run your agent (and spend your tokens). If you listen
on a non-loopback host with no `auth`, the adapter logs a one-time warning
through `options.logger`.

```ts
import { createAgent, createMockProvider } from '@lousho/build-ai-agent';
import { WebhookTriggerAdapter } from '@lousho/build-ai-agent/triggers';

const agent = createAgent({ prompt: 'You are helpful.', provider: createMockProvider() });

// HMAC of the RAW request body (GitHub / Shopify style): header `x-signature-256: sha256=<hex>`.
new WebhookTriggerAdapter({
  port: 8787,
  auth: { type: 'hmac', secret: process.env.WEBHOOK_SECRET ?? '' },
}).listen(agent, (input) => agent.send(input));

// Replay protection: the signed payload becomes `${timestamp}.${body}` and
// requests more than `toleranceSeconds` (default 300) old are rejected.
new WebhookTriggerAdapter({
  auth: {
    type: 'hmac',
    secret: process.env.WEBHOOK_SECRET ?? '',
    header: 'x-signature',
    timestampHeader: 'x-timestamp',
    toleranceSeconds: 120,
  },
});

// A shared bearer token (`Authorization: Bearer <token>`).
new WebhookTriggerAdapter({ auth: { type: 'bearer', token: process.env.WEBHOOK_TOKEN ?? '' } });

// Anything else: return true to accept. `rawBody` is a Buffer of the exact bytes received.
new WebhookTriggerAdapter({
  auth: { type: 'custom', verify: (req) => req.headers['x-api-key'] === process.env.API_KEY },
});
```

HMAC options: `header` (default `x-signature-256`), `algorithm` (`sha256` or
`sha1`, default `sha256`), `prefix` (default `sha256=`; `''` for a bare
digest), `timestampHeader` and `toleranceSeconds`. Signatures and bearer
tokens are compared in constant time. A request that fails authentication gets
a generic `401 {"error":"Unauthorized"}` - the response never says which check
failed - and the reason (never a secret or signature) is logged at `warn`
level. Serve webhooks over HTTPS (terminate TLS in front of the adapter) so
tokens and payloads are not sent in clear text.

## Slack

### Slack request signatures

**Deprecated.** `SlackTriggerAdapter` is replaced by `slackChannel()` mounted with `mountChannels()` (see [Slack in Channels](./channels.md#slack)): one session per Slack thread, approval buttons, and the signature check built in. `verifySlackSignature()` stays and is not deprecated.

```ts
import { createAgent, createMockProvider, mountChannels, slackChannel } from '@lousho/build-ai-agent';

const agent = createAgent({ instructions: 'You are helpful.', provider: createMockProvider() });

const handler = mountChannels(agent, [
  slackChannel({
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
    botToken: process.env.SLACK_BOT_TOKEN ?? '',
  }),
]);
```

`SlackTriggerAdapter.handleRequest({ headers, rawBody })` handles a raw Slack
Events API request and returns the `{ status, body }` to send back. **Set
`signingSecret` for any endpoint reachable from outside your machine**: without
it, anyone who can reach the endpoint can run your agent, and `listen()` logs a
one-time warning through `options.logger`. With it, every request is verified
as [Slack documents](https://docs.slack.dev/authentication/verifying-requests-from-slack)
before the body is parsed: HMAC-SHA256 over `v0:{X-Slack-Request-Timestamp}:{raw body}`,
compared in constant time with `X-Slack-Signature` (`v0=<hex>`), and requests
more than five minutes old are rejected. Failures get a generic
`401 {"error":"Unauthorized"}`; the reason (never a secret or signature) is
logged at `warn` level. The signed `url_verification` handshake is answered
after verification.

```ts
import { createAgent, createMockProvider } from '@lousho/build-ai-agent';
import { SlackTriggerAdapter, verifySlackSignature } from '@lousho/build-ai-agent/triggers';
import * as http from 'node:http';

const agent = createAgent({ prompt: 'You are helpful.', provider: createMockProvider() });
const slack = new SlackTriggerAdapter({ signingSecret: process.env.SLACK_SIGNING_SECRET });
slack.listen(agent, (input) => agent.send(input));

http
  .createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      const { status, body } = await slack.handleRequest({ headers: req.headers, rawBody: Buffer.concat(chunks) });
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
  })
  .listen(3000);

// Your own handler (slash commands, interactivity)? Verify the RAW body yourself:
const authentic = verifySlackSignature({
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
  timestamp: '1700000000', // the X-Slack-Request-Timestamp header
  signature: 'v0=...', // the X-Slack-Signature header
  rawBody: '{"type":"url_verification"}',
});
```

`handleRequest` answers Slack after the agent finishes; Slack expects a reply
within three seconds, so for slow agents acknowledge first and run the agent in
the background.

## Cron

### Cron schedules

**Deprecated.** `CronTriggerAdapter` is replaced by `defineSchedule()` with `startSchedules()` (see [Schedules](./schedules.md)), which also works from an agent directory's `schedules/` and from a spec file's cron triggers. `parseCronExpression()` and `CronExpressionError` stay. Schedules have no `intervalMs`: write the equivalent cron expression (`*/5 * * * *` for every five minutes), or keep a `setInterval` that calls `agent.send()`.

```ts
import { createAgent, createMockProvider, defineSchedule, startSchedules } from '@lousho/build-ai-agent';

const agent = createAgent({ instructions: 'You are helpful.', provider: createMockProvider() });

const queue = defineSchedule({
  cron: '*/15 9-17 * * MON-FRI',
  timezone: 'Europe/Paris',
  prompt: 'Check the support queue',
});
const running = startSchedules(agent, [queue]);
// later, on shutdown:
running.stop();
```

`CronTriggerAdapter` takes either a fixed `intervalMs` or a real cron
expression:

```ts
import { createAgent, createMockProvider } from '@lousho/build-ai-agent';
import { CronTriggerAdapter } from '@lousho/build-ai-agent/triggers';

const agent = createAgent({ prompt: 'You are helpful.', provider: createMockProvider() });

new CronTriggerAdapter({
  cron: '*/15 9-17 * * MON-FRI', // minute hour day-of-month month day-of-week
  timezone: 'Europe/Paris', // IANA name; defaults to the machine's local zone
  input: 'Check the support queue',
  onResult: (result, error) => console.log(error ?? result?.text),
}).listen(agent, (input) => agent.send(input));
```

Supported syntax: `*`, lists (`1,15`), ranges (`1-5`), steps (`*/15`,
`10-40/10`), month names (`JAN`) and weekday names (`MON`), with `0` and `7`
both meaning Sunday, plus the `@hourly`, `@daily` (or `@midnight`), `@weekly`,
`@monthly` and `@yearly` (or `@annually`) shortcuts. As in
classic cron, when both day-of-month and day-of-week are restricted a day
matches if either does. An invalid expression throws a `CronExpressionError`
naming the field and showing a valid example. `parseCronExpression(expr,
timezone).nextRun(after)` is exported if you need the next fire time.

Around daylight-saving changes, a time that does not exist (spring forward) is
skipped for that day, and a time that happens twice (fall back) fires once;
an every-hour schedule keeps firing hourly. The timer is re-armed after each
run from the scheduled time (no drift, no double fire), and `stop()` clears it.
