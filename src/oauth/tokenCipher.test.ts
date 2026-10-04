/**
 * N9a: the token cipher. AES-256-GCM via Web Crypto, a fresh IV per write,
 * the record key as AAD, an application-supplied key and no default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError, SDKError } from '../execution/errors';
import { generateTokenKey, TokenCipher } from './tokenCipher';
import { errorText, SENTINEL_ACCESS } from './tokenStore.contract';

const KEY = generateTokenKey();
const OTHER = generateTokenKey();

afterEach(() => { vi.unstubAllEnvs(); });

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as SDKError).code;
  }
}

describe('generateTokenKey', () => {
  it('returns 32 random bytes as base64, different each call', () => {
    expect(KEY).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(atob(KEY)).toHaveLength(32);
    expect(generateTokenKey()).not.toBe(generateTokenKey());
  });
});

describe('TokenCipher', () => {
  it('round-trips a record', async () => {
    const cipher = TokenCipher.fromOption(KEY, 'test');
    const sealed = await cipher.seal(SENTINEL_ACCESS, 'github|app');
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(sealed).not.toContain(SENTINEL_ACCESS);
    expect(atob(sealed.split('.')[1])).toHaveLength(12);
    expect(await cipher.open(sealed, 'github|app', 'token')).toBe(SENTINEL_ACCESS);
  });

  it('two writes of the same token produce different ciphertexts (fresh IV each time)', async () => {
    const cipher = TokenCipher.fromOption(KEY, 'test');
    const [a, b] = [await cipher.seal(SENTINEL_ACCESS, 'k'), await cipher.seal(SENTINEL_ACCESS, 'k')];
    expect(a).not.toBe(b);
    expect(a.split('.')[1]).not.toBe(b.split('.')[1]);
  });

  it('a different key fails with LOUSHO_TOKEN_DECRYPT_FAILED, naming the record, not the token', async () => {
    const sealed = await TokenCipher.fromOption(KEY, 'test').seal(SENTINEL_ACCESS, 'github|app');
    const wrong = TokenCipher.fromOption(OTHER, 'test').open(sealed, 'github|app', 'token for provider "github"');
    expect(await codeOf(wrong)).toBe('LOUSHO_TOKEN_DECRYPT_FAILED');
    const text = await errorText(TokenCipher.fromOption(OTHER, 'test').open(sealed, 'github|app', 'token for provider "github"'));
    expect(text).toContain('provider "github"');
    expect(text).not.toContain(SENTINEL_ACCESS);
    expect(text).not.toContain(sealed);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(OTHER);
  });

  it('a ciphertext moved to another record key (AAD) fails', async () => {
    const cipher = TokenCipher.fromOption(KEY, 'test');
    const sealed = await cipher.seal(SENTINEL_ACCESS, 'github|user||alice');
    expect(await codeOf(cipher.open(sealed, 'github|user||mallory', 'token'))).toBe('LOUSHO_TOKEN_DECRYPT_FAILED');
  });

  it('a changed or malformed record fails the same way', async () => {
    const cipher = TokenCipher.fromOption(KEY, 'test');
    const sealed = await cipher.seal(SENTINEL_ACCESS, 'k');
    const [version, iv, data] = sealed.split('.');
    const flipped = `${data.slice(0, 4)}${data[4] === 'A' ? 'B' : 'A'}${data.slice(5)}`;
    for (const bad of [`${version}.${iv}.${flipped}`, `v2.${iv}.${data}`, 'garbage', `${version}.${iv}`, `${version}.!!!.${data}`, `${version}.${btoa('short')}.${data}`]) {
      expect(await codeOf(cipher.open(bad, 'k', 'token')), bad).toBe('LOUSHO_TOKEN_DECRYPT_FAILED');
    }
  });

  it('rotates: writes with the first key, reads with any listed key', async () => {
    const old = TokenCipher.fromOption(OTHER, 'test');
    const sealedOld = await old.seal('old-record', 'k');
    const rotated = TokenCipher.fromOption([KEY, OTHER], 'test');
    expect(await rotated.open(sealedOld, 'k', 'token')).toBe('old-record');
    const sealedNew = await rotated.seal('new-record', 'k');
    expect(await TokenCipher.fromOption(KEY, 'test').open(sealedNew, 'k', 'token')).toBe('new-record');
    expect(await codeOf(old.open(sealedNew, 'k', 'token'))).toBe('LOUSHO_TOKEN_DECRYPT_FAILED');
  });

  it('has no default key: sealing or opening without one is LOUSHO_TOKEN_KEY_MISSING', async () => {
    vi.stubEnv('LOUSHO_TOKEN_KEY', '');
    const cipher = TokenCipher.fromOption(undefined, 'SqliteStore');
    expect(cipher.hasKey).toBe(false);
    expect(await codeOf(cipher.seal('x', 'k'))).toBe('LOUSHO_TOKEN_KEY_MISSING');
    expect(await codeOf(cipher.open('v1.a.b', 'k', 'token'))).toBe('LOUSHO_TOKEN_KEY_MISSING');
    await expect(cipher.seal('x', 'k')).rejects.toThrow(/SqliteStore has no OAuth token key/);
    await expect(cipher.seal('x', 'k')).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('reads LOUSHO_TOKEN_KEY (comma-separated, newest first) when no option is given', async () => {
    vi.stubEnv('LOUSHO_TOKEN_KEY', ` ${KEY} , ${OTHER}\n`);
    const fromEnv = TokenCipher.fromOption(undefined, 'test');
    const sealed = await fromEnv.seal('v', 'k');
    expect(await TokenCipher.fromOption(KEY, 'test').open(sealed, 'k', 'token')).toBe('v');
    const sealedOld = await TokenCipher.fromOption(OTHER, 'test').seal('o', 'k');
    expect(await fromEnv.open(sealedOld, 'k', 'token')).toBe('o');
  });

  it('refuses a key that is not exactly 32 bytes of base64, without echoing it', () => {
    const short = btoa('sixteen-bytes!!!');
    for (const bad of [short, 'not base64 at all', `${KEY}AAAA`, '', KEY.slice(0, -1)]) {
      let thrown: unknown;
      try {
        TokenCipher.fromOption(bad, 'test');
      } catch (error) {
        thrown = error;
      }
      expect(thrown, bad).toBeInstanceOf(ConfigurationError);
      expect((thrown as Error).message).toMatch(/must be 32 random bytes as base64/);
      if (bad) expect((thrown as Error).message).not.toContain(bad);
    }
    expect(() => TokenCipher.fromOption([KEY, short], 'test')).toThrow(/at index 1 in tokenKey/);
    vi.stubEnv('LOUSHO_TOKEN_KEY', short);
    expect(() => TokenCipher.fromOption(undefined, 'test')).toThrow(/in LOUSHO_TOKEN_KEY/);
  });
});
