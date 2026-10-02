/** Test keys and tokens for the auth tests: generated with Web Crypto at test time, nothing checked in. */
import type { JwtAlgorithm } from '../jwt';
import { buffer } from '../encoding';

const textBytes = (text: string) => new TextEncoder().encode(text);

export function base64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? textBytes(bytes) : bytes;
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** At least 32 bytes, as `jwt({ secret })` requires. */
export const SECRET = 'test-secret-that-is-long-enough-for-hs256';

export const nowSec = () => Math.floor(Date.now() / 1000);

export interface SigningKey {
  alg: JwtAlgorithm;
  sign: (data: Uint8Array) => Promise<Uint8Array>;
}

export async function hmacKey(secret = SECRET, alg: JwtAlgorithm = 'HS256'): Promise<SigningKey> {
  const hash = `SHA-${alg.slice(2)}`;
  const key = await crypto.subtle.importKey('raw', textBytes(secret), { name: 'HMAC', hash }, false, ['sign']);
  return { alg, sign: async (data) => new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer(data))) };
}

export interface PublicSigningKey extends SigningKey {
  pem: string;
  jwk: JsonWebKey;
}

async function exportPublic(publicKey: CryptoKey): Promise<{ pem: string; jwk: JsonWebKey }> {
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
  const b64 = btoa(String.fromCharCode(...spki)).replace(/(.{64})/g, '$1\n');
  return { pem: `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`, jwk: await crypto.subtle.exportKey('jwk', publicKey) };
}

export async function rsaKey(modulusLength = 2048): Promise<PublicSigningKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  return {
    alg: 'RS256',
    ...(await exportPublic(pair.publicKey)),
    sign: async (data) => new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, buffer(data))),
  };
}

export async function ecKey(): Promise<PublicSigningKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return {
    alg: 'ES256',
    ...(await exportPublic(pair.publicKey)),
    sign: async (data) => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, buffer(data))),
  };
}

/** A compact JWS over `claims` (default: `sub: 'u1'`, valid for 10 minutes). `header` is merged into `{ alg, typ }`. */
export async function signToken(key: SigningKey, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Promise<string> {
  const head = base64url(JSON.stringify({ alg: key.alg, typ: 'JWT', ...header }));
  const body = base64url(JSON.stringify({ sub: 'u1', exp: nowSec() + 600, ...claims }));
  const signature = await key.sign(textBytes(`${head}.${body}`));
  return `${head}.${body}.${base64url(signature)}`;
}

/** An unsigned token (`alg: none`, empty or junk signature). */
export function unsignedToken(claims: Record<string, unknown> = {}, signature = 'AAAA'): string {
  return `${base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64url(JSON.stringify({ sub: 'u1', exp: nowSec() + 600, ...claims }))}.${signature}`;
}

export const bearer = (token: string, url = 'https://agent.test/chat') => new Request(url, { headers: { authorization: `Bearer ${token}` } });

/** A fake `fetch` serving JSON documents by URL, recording every URL asked for. */
export function fakeFetch(documents: Record<string, unknown>): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const document = documents[url];
    return document === undefined ? new Response('not found', { status: 404 }) : Response.json(document);
  }) as typeof fetch & { urls: string[] };
  fn.urls = urls;
  return fn;
}
