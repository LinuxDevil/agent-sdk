/**
 * The webhook channel (LOU-P7): `WebhookTriggerAdapter`'s request handling
 * (LOU-T5, auth from LOU-D13) on the channel contract. The adapter delegates
 * its auth and parsing here. Node-only: HMAC checks use `node:crypto`.
 */
import type { IncomingMessage } from 'node:http';
import { newId } from '../utils/id';
import { assertValidWebhookAuth, checkWebhookAuth, type WebhookAuth } from '../triggers/webhookAuth';
import { defineChannel, type Channel, type ChannelAuthResult, type ChannelInbound, type ChannelRequest } from './defineChannel';

/** Options of {@link webhookChannel}. */
export interface WebhookChannelOptions {
  /** Route segment. Default `webhook`. */
  name?: string;
  /** Shorthand for `auth: { type: 'hmac', secret }` (header `x-signature-256: sha256=<hex>` over the raw body). */
  secret?: string;
  /** Any `WebhookTriggerAdapter` auth (hmac with options, bearer, custom). Wins over `secret`. */
  auth?: WebhookAuth;
}

/** A webhook channel: `verify` always resolves a `ChannelAuthResult`. */
export interface WebhookChannel extends Channel {
  verify(req: ChannelRequest): Promise<ChannelAuthResult>;
  parse(req: ChannelRequest): Promise<ChannelInbound>;
}

/** The agent input for a raw request body: its JSON `input` string if it has one, else the body itself. */
function parseWebhookInput(raw: string): { input: string; sessionKey?: unknown } {
  if (!raw) return { input: '' };
  try {
    const parsed = JSON.parse(raw) as { input?: unknown; sessionKey?: unknown } | null;
    return typeof parsed?.input === 'string' ? { input: parsed.input, sessionKey: parsed.sessionKey } : { input: raw };
  } catch {
    return { input: raw };
  }
}

/** Checks `req` against `auth`; `reason` (never a secret or signature) says why it failed. */
async function verifyWebhook(auth: WebhookAuth | undefined, req: ChannelRequest): Promise<ChannelAuthResult> {
  if (!auth) return { ok: true };
  const body = Buffer.from(req.rawBody.buffer, req.rawBody.byteOffset, req.rawBody.byteLength);
  const reason = await checkWebhookAuth(auth, (req.native ?? { headers: req.headers }) as IncomingMessage, body);
  return { ok: reason === undefined, reason };
}

/**
 * A generic webhook: the body's JSON `input` string (or the whole body) is
 * the input, and the response is the turn's `ExecutionResult` as JSON, as
 * with `WebhookTriggerAdapter`. Each request is a one-shot session unless the
 * JSON body has a `sessionKey` string. With `secret` or `auth`, a request
 * that fails the check gets 401.
 *
 * @example
 * ```ts
 * import { webhookChannel } from '@lousho/build-ai-agent';
 *
 * const hooks = webhookChannel({ secret: process.env.WEBHOOK_SECRET ?? '' });
 * ```
 */
export function webhookChannel(options: WebhookChannelOptions = {}): WebhookChannel {
  const auth: WebhookAuth | undefined = options.auth ?? (options.secret !== undefined ? { type: 'hmac', secret: options.secret } : undefined);
  if (auth) assertValidWebhookAuth(auth);
  const channel: WebhookChannel = {
    name: options.name ?? 'webhook',
    verify: (req) => verifyWebhook(auth, req),
    async parse(req) {
      const { input, sessionKey } = parseWebhookInput(req.text);
      return { sessionKey: typeof sessionKey === 'string' && sessionKey ? sessionKey : newId(), input, replyTo: null };
    },
    async reply({ text, result, respond }) {
      respond?.(200, result ?? { text });
    },
  };
  defineChannel(channel);
  return channel;
}
