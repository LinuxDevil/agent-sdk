/**
 * Slack request signatures without `node:*` imports, so a Worker
 * host can verify them too. The header and timestamp checks are shared with
 * the `node:crypto` `checkSlackSignature()` in webhookAuth.ts; this module adds
 * the Web Crypto HMAC that `slackChannel()` uses.
 *
 * Scheme: https://docs.slack.dev/authentication/verifying-requests-from-slack
 * (HMAC-SHA256 over `v0:{timestamp}:{raw body}`, sent as `v0=<hex>`).
 */

/** Slack's documented replay window: reject requests more than five minutes from local time. */
const SLACK_TOLERANCE_SECONDS = 300;
const SLACK_SIGNATURE_PATTERN = /^v0=[0-9a-f]{64}$/i;

/** How far ahead of local time a signed timestamp may be (clock skew); a timestamp further ahead could be replayed for longer than the window. */
const MAX_FUTURE_SKEW_SECONDS = 60;

/**
 * Whether a Unix timestamp is at most `toleranceSeconds` old and at most a
 * minute (or `toleranceSeconds`, if smaller) ahead of `nowMs`. `unit` is
 * `'seconds'` (Slack, Discord), or `'auto'`: milliseconds when the value is
 * past 1e12.
 */
export function isFresh(timestamp: string, toleranceSeconds: number, nowMs: number, unit: 'seconds' | 'auto' = 'seconds'): boolean {
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed)) return false;
  const seconds = unit === 'auto' && parsed > 1e12 ? parsed / 1000 : parsed;
  const age = nowMs / 1000 - seconds;
  return age <= toleranceSeconds && age >= -Math.min(toleranceSeconds, MAX_FUTURE_SKEW_SECONDS);
}

/** The checks that need no HMAC: a short reason (no secret or signature in it) when they fail. */
export function precheckSlackSignature(
  signingSecret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  now: number
): string | undefined {
  if (!signingSecret) return 'no signing secret configured';
  if (timestamp === undefined || signature === undefined) return 'missing signature headers';
  if (!SLACK_SIGNATURE_PATTERN.test(signature)) return 'malformed signature';
  if (!/^\d+$/.test(timestamp) || !isFresh(timestamp, SLACK_TOLERANCE_SECONDS, now)) return 'stale or invalid timestamp';
  return undefined;
}

/**
 * Web Crypto version of `checkSlackSignature()`: resolves a short reason when
 * the request is not authentic, `undefined` when it is. `crypto.subtle.verify`
 * compares in constant time.
 */
export async function checkSlackSignatureWeb(
  signingSecret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: Uint8Array,
  now: number = Date.now()
): Promise<string | undefined> {
  const failure = precheckSlackSignature(signingSecret, timestamp, signature, now);
  if (failure !== undefined || timestamp === undefined || signature === undefined) return failure;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const prefix = encoder.encode(`v0:${timestamp}:`);
  const data = new Uint8Array(prefix.length + rawBody.length);
  data.set(prefix);
  data.set(rawBody, prefix.length);
  const digest = new Uint8Array((signature.slice(3).match(/../g) ?? []).map((byte) => parseInt(byte, 16)));
  return (await crypto.subtle.verify('HMAC', key, digest, data)) ? undefined : 'signature mismatch';
}
