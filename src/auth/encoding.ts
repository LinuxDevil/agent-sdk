/** Shared byte helpers of the auth helpers: base64(url), UTF-8, constant-time comparison. No `node:*` import. */

const BASE64URL = /^[A-Za-z0-9_-]*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Bytes of a strict base64url string (no padding); `undefined` when it is not one. */
export function fromBase64Url(text: string): Uint8Array | undefined {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return undefined;
  return fromBase64(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '='));
}

/** Bytes of a base64 string; `undefined` when it is not one. */
export function fromBase64(text: string): Uint8Array | undefined {
  if (!BASE64.test(text) || text.length % 4 !== 0) return undefined;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

/** UTF-8 text of `bytes`; `undefined` for invalid UTF-8. */
export function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** A fresh ArrayBuffer copy of `bytes` (Web Crypto's `BufferSource` without shared-buffer typing issues). */
export function buffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/** SHA-256 of `value`'s UTF-8 bytes. */
export async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Whether two equal-length digests are equal, without an early exit. */
export function sameDigest(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0);
  return diff === 0;
}

/** The token of an `Authorization: Bearer <token>` header, or `undefined`. */
export function bearerToken(header: string | null): string | undefined {
  return /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1];
}

/** Whether `url` may serve keys or discovery: https, or plain http only on a loopback host (local development). */
export function isTrustedKeyUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' || (protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname));
  } catch {
    return false;
  }
}

/** Constant-time string equality: both sides are hashed to one length first, so neither length nor content leaks through timing. */
export async function sameSecret(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return sameDigest(a, b);
}
