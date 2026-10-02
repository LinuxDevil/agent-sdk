/**
 * N11b: GitHub App authentication - PKCS#1 and PKCS#8 private keys, the RS256
 * JWT, and the installation token cache. A key pair is generated in the test;
 * a fake `fetch` stands in for the REST API.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { createInstallationTokens, pemToPkcs8, signAppJwt } from './githubAppAuth';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs1 = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
const pkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const spki = new Uint8Array(pair.publicKey.export({ type: 'spki', format: 'der' }));

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

async function verified(jwt: string): Promise<boolean> {
  const [header, payload, signature] = jwt.split('.');
  const key = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, new Uint8Array(Buffer.from(signature, 'base64url')), new TextEncoder().encode(`${header}.${payload}`));
}

describe('pemToPkcs8', () => {
  it('wraps a PKCS#1 key into the PKCS#8 bytes Node produces for the same key, and keeps a PKCS#8 key as is', () => {
    const expected = new Uint8Array(pair.privateKey.export({ type: 'pkcs8', format: 'der' }));

    expect(Buffer.from(pemToPkcs8(pkcs1)).equals(Buffer.from(expected))).toBe(true);
    expect(Buffer.from(pemToPkcs8(pkcs8)).equals(Buffer.from(expected))).toBe(true);
  });

  it('accepts a key whose newlines are the two characters backslash and n, and rejects anything else', () => {
    expect(pemToPkcs8(pkcs8.replace(/\n/g, '\n')).length).toBeGreaterThan(1000);
    expect(() => pemToPkcs8('not a key')).toThrow(/PEM private key/);
    expect(() => pemToPkcs8('-----BEGIN PRIVATE KEY-----\n***\n-----END PRIVATE KEY-----')).toThrow(/valid PEM/);
  });
});

describe('signAppJwt', () => {
  it.each([
    ['PKCS#1', pkcs1],
    ['PKCS#8', pkcs8],
  ])('signs an RS256 JWT that verifies with the public key (%s key)', async (_, key) => {
    const jwt = await signAppJwt('12345', key, 1_700_000_000_000);
    const [header, payload] = jwt.split('.');

    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(payload)).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: '12345' });
    expect(await verified(jwt)).toBe(true);
  });

  it('refuses a key that is PEM but not an RSA key, without echoing it', async () => {
    const bogus = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----';

    await expect(signAppJwt('1', bogus)).rejects.toThrow(/could not be imported/);
  });
});

describe('createInstallationTokens', () => {
  function fakeApi() {
    const calls: Array<{ url: string; authorization: string }> = [];
    let n = 0;
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), authorization: String((init?.headers as Record<string, string>).authorization) });
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ token: `ghs_token${++n}`, expires_at: new Date(clock.now + 60 * 60 * 1000).toISOString() }), { status: 201 });
    });
    return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
  }
  const clock = { now: 1_700_000_000_000 };

  it('exchanges a verified JWT once and reuses the token until 5 minutes before it expires', async () => {
    clock.now = 1_700_000_000_000;
    const api = fakeApi();
    const tokens = createInstallationTokens({ appId: '12345', privateKey: pkcs1, fetch: api.fetch, now: () => clock.now });

    expect(await Promise.all([tokens(99), tokens(99)])).toEqual(['ghs_token1', 'ghs_token1']);
    expect(await tokens(99)).toBe('ghs_token1');
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].url).toBe('https://api.github.com/app/installations/99/access_tokens');
    expect(await verified(api.calls[0].authorization.replace('Bearer ', ''))).toBe(true);

    clock.now += 54 * 60 * 1000; // 6 minutes left
    expect(await tokens(99)).toBe('ghs_token1');
    clock.now += 2 * 60 * 1000; // 4 minutes left: refresh
    expect(await tokens(99)).toBe('ghs_token2');
    expect(api.calls).toHaveLength(2);
  });

  it('keeps a token per installation and honors apiUrl', async () => {
    const api = fakeApi();
    const tokens = createInstallationTokens({ appId: '1', privateKey: pkcs8, apiUrl: 'https://ghe.example.com/api/v3/', fetch: api.fetch, now: () => clock.now });

    expect(await tokens(1)).toBe('ghs_token1');
    expect(await tokens(2)).toBe('ghs_token2');
    expect(api.calls.map((c) => c.url)).toEqual(['https://ghe.example.com/api/v3/app/installations/1/access_tokens', 'https://ghe.example.com/api/v3/app/installations/2/access_tokens']);
  });

  it('a failed exchange names the call and status, never the JWT, and is retried next time', async () => {
    let status = 401;
    const fetch = vi.fn(async () => (status === 401 ? new Response('{"message":"bad"}', { status }) : new Response(JSON.stringify({ token: 'ghs_ok', expires_at: new Date(clock.now + 3_600_000).toISOString() }), { status: 201 })));
    const tokens = createInstallationTokens({ appId: '1', privateKey: pkcs1, fetch: fetch as unknown as typeof globalThis.fetch, now: () => clock.now });

    const error = (await tokens(5).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('githubChannel: POST /app/installations/5/access_tokens failed: 401');
    expect(error).toMatchObject({ code: 'LOUSHO_CHANNEL_REQUEST_FAILED' });
    status = 201;
    expect(await tokens(5)).toBe('ghs_ok');
  });

  it('a network error does not carry the request into the message', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      throw new Error(`boom ${String((init?.headers as Record<string, string>).authorization)}`);
    });
    const tokens = createInstallationTokens({ appId: '1', privateKey: pkcs1, fetch: fetch as unknown as typeof globalThis.fetch });

    const error = (await tokens(5).catch((e: unknown) => e)) as Error;

    expect(error.message).toContain('githubChannel: POST /app/installations/5/access_tokens failed: the request did not complete');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('Bearer');
  });
});
