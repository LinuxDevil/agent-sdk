/**
 * Webhook request authentication (LOU-D13).
 *
 * Pure verification helpers used by `WebhookTriggerAdapter`. They never
 * throw for a bad request - they return the (internal) reason a request was
 * rejected so the adapter can log it, while the HTTP response stays generic.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

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
      throw new Error("WebhookTriggerAdapter: auth.secret must be a non-empty string (e.g. { type: 'hmac', secret: process.env.WEBHOOK_SECRET }).");
    }
    if (auth.toleranceSeconds !== undefined && !auth.timestampHeader) {
      throw new Error('WebhookTriggerAdapter: auth.toleranceSeconds has no effect without auth.timestampHeader. Set timestampHeader (e.g. "x-timestamp") or remove toleranceSeconds.');
    }
  } else if (auth.type === 'bearer') {
    if (!auth.token) {
      throw new Error("WebhookTriggerAdapter: auth.token must be a non-empty string (e.g. { type: 'bearer', token: process.env.WEBHOOK_TOKEN }).");
    }
  } else if (auth.type !== 'custom' || typeof auth.verify !== 'function') {
    throw new Error("WebhookTriggerAdapter: auth.type must be 'hmac', 'bearer' or 'custom' (custom needs a verify(req, rawBody) function).");
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

function isFresh(timestamp: string, toleranceSeconds: number, nowMs: number): boolean {
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed)) return false;
  const seconds = parsed > 1e12 ? parsed / 1000 : parsed;
  return Math.abs(nowMs / 1000 - seconds) <= toleranceSeconds;
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
