/**
 * The webhook channel (LOU-P7): `WebhookTriggerAdapter`'s request handling
 * (LOU-T5, auth from LOU-D13) on the channel contract. The adapter delegates
 * its auth and parsing here. Node-only: HMAC checks use `node:crypto`.
 */
import type { IncomingMessage } from 'node:http';
import { newId } from '../utils/id';
import type { Principal } from '../auth/types';
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
  /**
   * Who is calling, as the turn's `principal` (N10a: memory scopes, `model` /
   * `instructions` / `tools` functions) - e.g. which alerting system sent the
   * hook. `body` is the parsed JSON body (`undefined` when it is not JSON);
   * `req` carries the headers. Set it only from data `auth` vouched for.
   */
  principal?: (body: unknown, req: ChannelRequest) => Principal | undefined;
}

/** A webhook channel: `verify` always resolves a `ChannelAuthResult`. */
export interface WebhookChannel extends Channel {
  verify(req: ChannelRequest): Promise<ChannelAuthResult>;
  parse(req: ChannelRequest): Promise<ChannelInbound>;
}

/** The agent input for a raw request body: its JSON `input` string if it has one, else the body itself; `body` is the parsed JSON. */
function parseWebhookInput(raw: string): { input: string; sessionKey?: unknown; body?: unknown } {
  if (!raw) return { input: '' };
  try {
    const parsed = JSON.parse(raw) as { input?: unknown; sessionKey?: unknown } | null;
    return typeof parsed?.input === 'string' ? { input: parsed.input, sessionKey: parsed.sessionKey, body: parsed } : { input: raw, body: parsed };
  } catch {
    return { input: raw };
  }
}

/**
 * The request `checkWebhookAuth` reads headers from. A Node request is passed
 * through (custom verifiers may use other fields); on a Fetch host `native` is
 * a `Request` whose `Headers` cannot be indexed node-style, so the channel's
 * normalized (lower-cased) headers stand in for it.
 */
function authRequest(req: ChannelRequest): IncomingMessage {
  const headers = (req.native as { headers?: unknown } | undefined)?.headers;
  const nodeStyle = headers !== undefined && typeof (headers as { get?: unknown }).get !== 'function';
  return (nodeStyle ? req.native : { headers: req.headers }) as IncomingMessage;
}

/** Checks `req` against `auth`; `reason` (never a secret or signature) says why it failed. */
async function verifyWebhook(auth: WebhookAuth | undefined, req: ChannelRequest): Promise<ChannelAuthResult> {
  if (!auth) return { ok: true };
  const body = Buffer.from(req.rawBody.buffer, req.rawBody.byteOffset, req.rawBody.byteLength);
  const reason = await checkWebhookAuth(auth, authRequest(req), body);
  return { ok: reason === undefined, reason };
}

/**
 * A generic webhook: the body's JSON `input` string (or the whole body) is
 * the input, and the response is the turn's `ExecutionResult` as JSON, as
 * with `WebhookTriggerAdapter`. Each request is a one-shot session unless the
 * JSON body has a `sessionKey` string. With `secret` or `auth`, a request
 * that fails the check gets 401. `principal` names the caller of the turn
 * (an alerting system, an integration user) from the verified request.
 *
 * @example
 * ```ts
 * import { webhookChannel } from '@lousho/build-ai-agent';
 *
 * const hooks = webhookChannel({
 *   secret: process.env.WEBHOOK_SECRET ?? '',
 *   principal: (body) => {
 *     const source = (body as { source?: unknown } | undefined)?.source;
 *     return typeof source === 'string' ? { id: source, type: 'service', authenticator: 'webhook' } : undefined;
 *   },
 * });
 * ```
 */
export function webhookChannel(options: WebhookChannelOptions = {}): WebhookChannel {
  const auth: WebhookAuth | undefined = options.auth ?? (options.secret !== undefined ? { type: 'hmac', secret: options.secret } : undefined);
  if (auth) assertValidWebhookAuth(auth);
  const channel: WebhookChannel = {
    name: options.name ?? 'webhook',
    verify: (req) => verifyWebhook(auth, req),
    async parse(req) {
      const { input, sessionKey, body } = parseWebhookInput(req.text);
      const principal = options.principal?.(body, req);
      return { sessionKey: typeof sessionKey === 'string' && sessionKey ? sessionKey : newId(), input, ...(principal && { principal }), replyTo: null };
    },
    async reply({ text, result, respond }) {
      // On an approval pause `result.text` is empty (the last turn was a bare
      // tool call), so the human-readable prompt the channel computed is sent
      // too: a consumer can render it instead of rebuilding it from `approvalId`.
      if (result?.finishReason === 'awaiting-approval') return respond?.(200, { ...result, approvalPrompt: text });
      respond?.(200, result ?? { text });
    },
  };
  defineChannel(channel);
  return channel;
}
