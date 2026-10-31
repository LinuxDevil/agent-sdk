# Triggers

A trigger adapter turns one wake-up mechanism into an agent run. The `lousho/triggers` subpath is the extension point for your own mechanism (`TriggerAdapter`, `TriggerRegistry`) plus a few helpers shared with channels and schedules: the `WebhookAuth` shapes, `verifySlackSignature()` and `parseCronExpression()`. The built-in webhook, Slack and cron adapters were removed; see [Migrating from triggers](./upgrading.md#migrating-from-triggers).

## Choosing between triggers, channels and schedules

| | Use it for | Entry points |
|---|---|---|
| Triggers | The extension point for your own wake-up mechanism. | `TriggerAdapter`, `TriggerRegistry` |
| [Channels](./channels.md) | A surface people talk to. Each conversation maps to a session, and approvals and questions the agent pauses on go back to the surface. | `defineChannel()`, `mountChannels()`, `httpChannel()`, `webhookChannel()`, `slackChannel()` |
| [Schedules](./schedules.md) | Cron for agent directories and the node server, with support on the deployed targets. | `defineSchedule()`, `startSchedules()` |

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

`listen` takes both `agent` and `onEvent` on purpose. `agent` is the plain "prompt in, text out" surface, and `onEvent` is the entry point the adapter calls when its trigger fires: a simple caller passes `(input) => agent.send(input)`, while a caller with checkpointing, approval gates or abort control passes an `onEvent` that wraps all of that. Call `stop()` on the returned handle to shut the adapter down.

Reply semantics differ per adapter. An adapter whose reply is the open request (a webhook) has no `reply()`, one with no caller waiting (a clock) hands the result elsewhere, and one with an out-of-band reply channel (chat) implements `reply()`.

Write your own adapter by returning a handle from `listen`:

```ts
import { createAgent, createMockProvider } from 'lousho';
import type { TriggerAdapter } from 'lousho/triggers';

const agent = createAgent({ instructions: 'You are helpful.', provider: createMockProvider() });

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

## Webhook authentication

The `WebhookAuth` shapes are the reference for `webhookChannel({ auth })` (see [Channels](./channels.md)). `checkWebhookAuth()` and `assertValidWebhookAuth()` are exported for your own handler.

```ts no-run
import { createAgent, createMockProvider, mountChannels, webhookChannel } from 'lousho';

const agent = createAgent({ instructions: 'You are helpful.', provider: createMockProvider() });

// HMAC of the RAW request body (GitHub / Shopify style): header `x-signature-256: sha256=<hex>`.
const handler = mountChannels(agent, [
  webhookChannel({ auth: { type: 'hmac', secret: process.env.WEBHOOK_SECRET ?? '' } }),
]);

// Replay protection: the signed payload becomes `${timestamp}.${body}` and
// requests more than `toleranceSeconds` (default 300) old are rejected.
webhookChannel({
  auth: {
    type: 'hmac',
    secret: process.env.WEBHOOK_SECRET ?? '',
    header: 'x-signature',
    timestampHeader: 'x-timestamp',
    toleranceSeconds: 120,
  },
});

// A shared bearer token (`Authorization: Bearer <token>`).
webhookChannel({ auth: { type: 'bearer', token: process.env.WEBHOOK_TOKEN ?? '' } });

// Anything else: return true to accept. `rawBody` is a Buffer of the exact bytes received.
webhookChannel({
  auth: { type: 'custom', verify: (req) => req.headers['x-api-key'] === process.env.API_KEY },
});
```

HMAC options: `header` (default `x-signature-256`), `algorithm` (`sha256` or
`sha1`, default `sha256`), `prefix` (default `sha256=`; `''` for a bare
digest), `timestampHeader` and `toleranceSeconds` (a timestamp may also be at
most a minute ahead of local time). Signatures and bearer
tokens are compared in constant time. A request that fails authentication gets
a generic `401 {"error":"Unauthorized"}` - the response never says which check
failed. An invalid `auth` throws `LOUSHO_TRIGGER_INVALID`. Serve webhooks over
HTTPS (terminate TLS in front of the server) so tokens and payloads are not
sent in clear text.

## Slack request signatures

`slackChannel()` verifies every request for you (see [Slack in Channels](./channels.md#slack)). For your own handler (slash commands, interactivity), verify the RAW body with `verifySlackSignature()`: HMAC-SHA256 over `v0:{X-Slack-Request-Timestamp}:{raw body}`, compared in constant time with `X-Slack-Signature` (`v0=<hex>`). Requests more than five minutes old, or more than a minute ahead of local time, are rejected (the timestamp is in seconds, as Slack sends it). See [Slack's documentation](https://docs.slack.dev/authentication/verifying-requests-from-slack).

```ts no-run
import { verifySlackSignature } from 'lousho/triggers';

const authentic = verifySlackSignature({
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
  timestamp: '1700000000', // the X-Slack-Request-Timestamp header
  signature: 'v0=...', // the X-Slack-Signature header
  rawBody: '{"type":"url_verification"}',
});
```

## Cron expressions

`defineSchedule()` with `startSchedules()` runs cron (see [Schedules](./schedules.md)). `parseCronExpression(expr, timezone)` and `CronExpressionError` are exported if you need to validate an expression or compute the next fire time with `.nextRun(after)`.

Supported syntax: `*`, lists (`1,15`), ranges (`1-5`), steps (`*/15`,
`10-40/10`), month names (`JAN`) and weekday names (`MON`), with `0` and `7`
both meaning Sunday, plus the `@hourly`, `@daily` (or `@midnight`), `@weekly`,
`@monthly` and `@yearly` (or `@annually`) shortcuts. As in
classic cron, when both day-of-month and day-of-week are restricted a day
matches if either does. An invalid expression throws a `CronExpressionError`
naming the field and showing a valid example.

Around daylight-saving changes, a fixed-hour job whose time does not exist
(spring forward, e.g. `30 2 * * *`) runs once at the first instant after the
gap (03:00) instead of being skipped for the day, and a time that happens twice (fall back) fires once;
an every-hour schedule keeps firing hourly.
