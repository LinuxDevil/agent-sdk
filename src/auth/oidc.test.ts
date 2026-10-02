/** N10a: oidc() with a fake discovery document and key set. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SDKError } from '../utils/sdkError';
import { oidc } from './oidc';
import { bearer, ecKey, fakeFetch, rsaKey, signToken } from './__fixtures__/tokens';

const ISSUER = 'https://login.example.test';
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const JWKS = 'https://login.example.test/keys';
const AUD = 'client-123';

afterEach(() => vi.restoreAllMocks());

describe('oidc() (N10a)', () => {
  it('discovers the key set once and accepts a token from the issuer', async () => {
    const rs = await rsaKey();
    const fetch = fakeFetch({ [DISCOVERY]: { issuer: ISSUER, jwks_uri: JWKS }, [JWKS]: { keys: [{ ...rs.jwk, kid: 'r1' }] } });
    const auth = oidc({ issuer: ISSUER, audience: AUD, fetch });
    const token = await signToken(rs, { iss: ISSUER, aud: AUD, email: 'a@example.test' }, { kid: 'r1' });
    expect(await auth(bearer(token))).toEqual({
      id: 'u1',
      type: 'user',
      authenticator: 'oidc',
      issuer: ISSUER,
      claims: expect.objectContaining({ email: 'a@example.test' }),
    });
    expect(await auth(bearer(token))).toMatchObject({ id: 'u1' });
    expect(fetch.urls).toEqual([DISCOVERY, JWKS]);
  });

  it('refuses a discovery document that names another issuer (and never fetches its key set)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rs = await rsaKey();
    const fetch = fakeFetch({ [DISCOVERY]: { issuer: 'https://evil.test', jwks_uri: JWKS }, [JWKS]: { keys: [{ ...rs.jwk, kid: 'r1' }] } });
    const auth = oidc({ issuer: ISSUER, audience: AUD, fetch });
    expect(await auth(bearer(await signToken(rs, { iss: ISSUER, aud: AUD }, { kid: 'r1' })))).toBeNull();
    expect(fetch.urls).toEqual([DISCOVERY]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("names issuer 'https://evil.test'"));
  });

  it('refuses a plain-http jwks_uri, a token from another issuer, and one for another audience', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const es = await ecKey();
    const insecure = oidc({ issuer: ISSUER, audience: AUD, fetch: fakeFetch({ [DISCOVERY]: { issuer: ISSUER, jwks_uri: 'http://login.example.test/keys' } }) });
    expect(await insecure(bearer(await signToken(es, { iss: ISSUER, aud: AUD })))).toBeNull();

    const fetch = fakeFetch({ [DISCOVERY]: { issuer: ISSUER, jwks_uri: JWKS }, [JWKS]: { keys: [es.jwk] } });
    const auth = oidc({ issuer: ISSUER, audience: AUD, fetch });
    expect(await auth(bearer(await signToken(es, { iss: 'https://other.test', aud: AUD })))).toBeNull();
    expect(await auth(bearer(await signToken(es, { iss: ISSUER, aud: 'other-client' })))).toBeNull();
    expect(await auth(bearer(await signToken(es, { iss: ISSUER, aud: AUD })))).toMatchObject({ id: 'u1' });
  });

  it('retries a failed discovery at most every 30 s', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const rs = await rsaKey();
      const fetch = fakeFetch({});
      const auth = oidc({ issuer: ISSUER, audience: AUD, fetch });
      const token = await signToken(rs, { iss: ISSUER, aud: AUD });
      expect(await auth(bearer(token))).toBeNull();
      expect(await auth(bearer(token))).toBeNull();
      expect(fetch.urls).toEqual([DISCOVERY]);
      vi.setSystemTime(Date.now() + 30_000);
      await auth(bearer(token));
      expect(fetch.urls).toEqual([DISCOVERY, DISCOVERY]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses unusable options at construction', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
        return 'no error';
      } catch (error) {
        return (error as SDKError).code;
      }
    };
    expect(code(() => oidc({ issuer: 'http://login.example.test', audience: AUD }))).toBe('LOUSHO_AUTH_CONFIG_INVALID');
    expect(code(() => oidc({ issuer: ISSUER, audience: [] }))).toBe('LOUSHO_AUTH_CONFIG_INVALID');
    expect(code(() => oidc({ issuer: ISSUER, audience: AUD, algorithms: ['HS256'] }))).toBe('LOUSHO_AUTH_CONFIG_INVALID');
    expect(code(() => oidc({ issuer: ISSUER, audience: AUD, discoveryUrl: 'http://evil.test/.well-known/openid-configuration' }))).toBe('LOUSHO_AUTH_CONFIG_INVALID');
  });
});
