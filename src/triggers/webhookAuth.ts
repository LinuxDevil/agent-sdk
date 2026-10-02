/**
 * Webhook request authentication (LOU-D13).
 *
 * Pure verification helpers used by `WebhookTriggerAdapter`. They never
 * throw for a bad request - they return the (internal) reason a request was
 * rejected so the adapter can log it, while the HTTP response stays generic.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isFresh, precheckSlackSignature } from './slackSignature';
import { SDKError } from '../execution/errors';

/**
 * Verify a signature computed with a shared secret over the RAW request
 * body bytes (the format GitHub, Shopify and many others use).
 *
 * @example
 * ```ts
 * new WebhookTriggerAdapter({ auth: { type: 'hmac', secret: process.env.WEBHOOK_SECRET! } });
 * ```
 */
export interface HmacWebhookAuth {
  type: 'hmac';
  /** Shared secret used to compute the HMAC. */
  secret: string;
  /** Request header carrying the signature. Defaults to `'x-signature-256'`. */
  header?: string;
  /** HMAC hash algorithm. Defaults to `'sha256'`. */
  algorithm?: 'sha256' | 'sha1';
  /** Text the header value starts with before the hex digest. Defaults to `` `${algorithm}=` `` (`'sha256='`). Use `''` for a bare digest. */
  prefix?: string;
  /**
   * Header carrying a Unix timestamp (seconds, or milliseconds). When set,
   * the signed payload becomes `${timestamp}.${rawBody}` and requests whose
   * timestamp is further than `toleranceSeconds` from now are rejected,
   * which prevents replaying a captured request.
   */
  timestampHeader?: string;
  /** Maximum accepted clock difference in seconds. Defaults to 300. Requires `timestampHeader`. */
  toleranceSeconds?: number;
}

/**
 * Require an `Authorization: Bearer <token>` header.
 *
 * @example
 * ```ts
 * new WebhookTriggerAdapter({ auth: { type: 'bearer', token: process.env.WEBHOOK_TOKEN! } });
 * ```
 */
export interface BearerWebhookAuth {
  type: 'bearer';
  /** The expected token. */
  token: string;
}

/**
 * Bring your own check. `rawBody` is the exact bytes received (decode with
 * `rawBody.toString('utf8')`). Return `false` (or throw) to reject with 401.
 *
 * @example
 * ```ts
 * new WebhookTriggerAdapter({
 *   auth: { type: 'custom', verify: (req) => req.headers['x-api-key'] === process.env.API_KEY },
 * });
 * ```
 */
export interface CustomWebhookAuth {
  type: 'custom';
  verify(req: IncomingMessage, rawBody: Buffer): boolean | Promise<boolean>;
}

/** How `WebhookTriggerAdapter` authenticates inbound requests. */
export type WebhookAuth = HmacWebhookAuth | BearerWebhookAuth | CustomWebhookAuth;

const DEFAULT_TOLERANCE_SECONDS = 300;

/** Fails fast, at construction time, on a configuration that could never authenticate (or never reject) anything. */
export function assertValidWebhookAuth(auth: WebhookAuth): void {
  if (auth.type === 'hmac') {
    if (!auth.secret) {
      throw new SDKError("WebhookTriggerAdapter: auth.secret must be a non-empty string (e.g. { type: 'hmac', secret: process.env.WEBHOOK_SECRET }).", 'LOUSHO_TRIGGER_INVALID');
    }
    if (auth.toleranceSeconds !== undefined && !auth.timestampHeader) {
      throw new SDKError('WebhookTriggerAdapter: auth.toleranceSeconds has no effect without auth.timestampHeader. Set timestampHeader (e.g. "x-timestamp") or remove toleranceSeconds.', 'LOUSHO_TRIGGER_INVALID');
    }
  } else if (auth.type === 'bearer') {
    if (!auth.token) {
      throw new SDKError("WebhookTriggerAdapter: auth.token must be a non-empty string (e.g. { type: 'bearer', token: process.env.WEBHOOK_TOKEN }).", 'LOUSHO_TRIGGER_INVALID');
    }
  } else if (auth.type !== 'custom' || typeof auth.verify !== 'function') {
    throw new SDKError("WebhookTriggerAdapter: auth.type must be 'hmac', 'bearer' or 'custom' (custom needs a verify(req, rawBody) function).", 'LOUSHO_TRIGGER_INVALID');
  }
}

/**
 * Constant-time string comparison. Both sides are hashed first, so the
 * buffers always have equal length (`timingSafeEqual` throws otherwise) and
 * the length of the expected value is not leaked either.
 */
function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

function checkTimestamp(auth: HmacWebhookAuth, req: IncomingMessage, nowMs: number): string | undefined {
  if (!auth.timestampHeader) return undefined;
  const timestamp = headerValue(req, auth.timestampHeader);
  if (timestamp === undefined) return 'missing timestamp';
  return isFresh(timestamp, auth.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS, nowMs) ? undefined : 'stale timestamp';
}

function checkHmac(auth: HmacWebhookAuth, req: IncomingMessage, rawBody: Buffer, nowMs: number): string | undefined {
  const algorithm = auth.algorithm ?? 'sha256';
  const prefix = auth.prefix ?? `${algorithm}=`;
  const header = headerValue(req, auth.header ?? 'x-signature-256');
  if (header === undefined || !header.startsWith(prefix)) return 'missing or malformed signature';

  const timestampFailure = checkTimestamp(auth, req, nowMs);
  if (timestampFailure) return timestampFailure;

  const hmac = createHmac(algorithm, auth.secret);
  if (auth.timestampHeader) hmac.update(`${headerValue(req, auth.timestampHeader)}.`);
  const expected = hmac.update(rawBody).digest('hex');
  return safeEqual(header.slice(prefix.length).toLowerCase(), expected) ? undefined : 'signature mismatch';
}

function checkBearer(auth: BearerWebhookAuth, req: IncomingMessage): string | undefined {
  const match = /^Bearer (.+)$/i.exec(headerValue(req, 'authorization') ?? '');
  if (!match) return 'missing bearer token';
  return safeEqual(match[1], auth.token) ? undefined : 'bearer token mismatch';
}

async function checkCustom(auth: CustomWebhookAuth, req: IncomingMessage, rawBody: Buffer): Promise<string | undefined> {
  try {
    return (await auth.verify(req, rawBody)) === true ? undefined : 'custom verifier rejected the request';
  } catch {
    return 'custom verifier threw';
  }
}

/**
 * Checks a request against `auth`. Resolves to `undefined` when the request
 * is authentic, or to a short internal reason (safe to log - it contains no
 * secret, signature or token) when it is not.
 */
export async function checkWebhookAuth(
  auth: WebhookAuth,
  req: IncomingMessage,
  rawBody: Buffer,
  nowMs: number = Date.now()
): Promise<string | undefined> {
  if (auth.type === 'hmac') return checkHmac(auth, req, rawBody, nowMs);
  if (auth.type === 'bearer') return checkBearer(auth, req);
  return checkCustom(auth, req, rawBody);
}

/** Inputs of {@link verifySlackSignature}. */
export interface SlackSignatureInput {
  /** Your Slack app's signing secret (Basic Information > App Credentials). */
  signingSecret: string;
  /** The `X-Slack-Request-Timestamp` header value (Unix seconds). */
  timestamp: string | undefined;
  /** The `X-Slack-Signature` header value (`v0=<hex>`). */
  signature: string | undefined;
  /** The exact request body bytes, before any parsing. */
  rawBody: Buffer | string;
  /** Current time in milliseconds. Defaults to `Date.now()`; for tests. */
  now?: number;
}

/**
 * Internal check behind {@link verifySlackSignature}: resolves to a short
 * reason (safe to log - it contains no secret or signature) when the request
 * is not authentic, or `undefined` when it is.
 *
 * Scheme: https://docs.slack.dev/authentication/verifying-requests-from-slack
 * (formerly https://api.slack.com/authentication/verifying-requests-from-slack):
 * HMAC-SHA256 over `v0:{timestamp}:{raw body}`, sent as `v0=<hex>` in
 * `X-Slack-Signature`; requests more than five minutes old are rejected.
 */
export function checkSlackSignature(input: SlackSignatureInput): string | undefined {
  const { signingSecret, timestamp, signature, rawBody, now = Date.now() } = input;
  const failure = precheckSlackSignature(signingSecret, timestamp, signature, now);
  if (failure !== undefined || timestamp === undefined || signature === undefined) return failure;
  const expected = createHmac('sha256', signingSecret).update(`v0:${timestamp}:`).update(rawBody).digest('hex');
  return safeEqual(signature.slice(3).toLowerCase(), expected) ? undefined : 'signature mismatch';
}

/**
 * Verify a request really came from Slack. Use it in your own HTTP handler
 * (slash commands, interactivity, Events API) with the RAW body, before parsing.
 * Returns `false` for any invalid, missing, stale or tampered input; never throws.
 *
 * @example
 * ```ts
 * const ok = verifySlackSignature({
 *   signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
 *   timestamp: req.headers['x-slack-request-timestamp'] as string | undefined,
 *   signature: req.headers['x-slack-signature'] as string | undefined,
 *   rawBody,
 * });
 * ```
 */
export function verifySlackSignature(input: SlackSignatureInput): boolean {
  return checkSlackSignature(input) === undefined;
}
