/**
 * N10a: JWT verification. Keys are generated here with crypto.subtle (HMAC,
 * RSASSA-PKCS1-v1_5, ECDSA P-256); every refusal the helper promises has a case.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SDKError } from '../utils/sdkError';
import { jwksKeySource, jwt, verifyJwt, JwtVerificationError, type JwtChecks, type JwtRejection, type KeySource } from './jwt';
import { SECRET, base64url, bearer, ecKey, fakeFetch, hmacKey, nowSec, rsaKey, signToken, unsignedToken, type SigningKey } from './__fixtures__/tokens';

const AUD = 'agent-api';
const ISS = 'https://auth.example.test';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function rejection(promise: Promise<unknown>): Promise<JwtRejection | 'accepted'> {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    if (error instanceof JwtVerificationError) return error.reason;
    throw error;
  }
}

const secretSource = async (): Promise<KeySource> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return { keys: async () => [{ kty: 'oct', importFor: async () => key }] };
};

describe('jwt() (N10a)', () => {
  it('accepts a valid token of each family and maps it to a principal', async () => {
    const families: Array<[SigningKey, Parameters<typeof jwt>[0]]> = [];
    const hs = await hmacKey();
    families.push([hs, { secret: SECRET }]);
    const rs = await rsaKey();
    families.push([rs, { publicKey: rs.pem }]);
    const es = await ecKey();
    families.push([es, { publicKey: es.jwk }]);
    for (const [key, source] of families) {
      const auth = jwt({ ...source, issuer: ISS, audience: AUD });
      const principal = await auth(bearer(await signToken(key, { iss: ISS, aud: AUD, role: 'admin' })));
      expect(principal, key.alg).toMatchObject({ id: 'u1', type: 'user', authenticator: 'jwt', issuer: ISS, claims: { role: 'admin', aud: AUD } });
    }
  });

  it('accepts an RSA key given as a JWK, and an audience inside an aud array', async () => {
    const rs = await rsaKey();
    const auth = jwt({ publicKey: rs.jwk, audience: [AUD, 'other'] });
    expect(await auth(bearer(await signToken(rs, { aud: ['x', AUD] })))).toMatchObject({ id: 'u1' });
  });

  it('skips (null) a request without a bearer token, with a non-JWT token, or with any invalid token', async () => {
    const auth = jwt({ secret: SECRET, audience: AUD });
    expect(await auth(new Request('https://agent.test/'))).toBeNull();
    expect(await auth(bearer('plain-api-token'))).toBeNull();
    expect(await auth(bearer(unsignedToken({ aud: AUD })))).toBeNull();
    expect(await auth(bearer(await signToken(await hmacKey(), { aud: 'wrong' })))).toBeNull();
    expect(auth.challenges).toEqual([{ scheme: 'Bearer' }]);
  });

  it('a custom principal mapper decides, and a token without sub is skipped by default', async () => {
    const hs = await hmacKey();
    const custom = jwt({ secret: SECRET, audience: AUD, principal: (claims) => ({ id: String(claims.client_id), type: 'service', authenticator: 'jwt' }) });
    expect(await custom(bearer(await signToken(hs, { aud: AUD, client_id: 'svc-1' })))).toEqual({ id: 'svc-1', type: 'service', authenticator: 'jwt' });
    expect(await jwt({ secret: SECRET, audience: AUD })(bearer(await signToken(hs, { aud: AUD, sub: undefined })))).toBeNull();
  });

  it('allows any audience only when asked to', async () => {
    const hs = await hmacKey();
    expect(await jwt({ secret: SECRET, allowAnyAudience: true })(bearer(await signToken(hs, { aud: 'whatever' })))).toMatchObject({ id: 'u1' });
  });

  describe('construction (LOUSHO_AUTH_CONFIG_INVALID)', () => {
    const invalid = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof SDKError ? error.code : String(error);
      }
      return 'no error';
    };

    it('refuses unusable options', async () => {
      const rs = await rsaKey();
      const cases: Array<Parameters<typeof jwt>[0]> = [
        { audience: AUD }, // no key source
        { secret: SECRET, publicKey: rs.pem, audience: AUD }, // two key sources
        { secret: SECRET }, // no audience
        { secret: 'short', audience: AUD },
        { secret: SECRET, audience: AUD, algorithms: ['RS256'] }, // secret with an RS algorithm
        { publicKey: rs.pem, audience: AUD, algorithms: ['HS256'] }, // a public key used as an HMAC secret
        { publicKey: rs.pem, audience: AUD, algorithms: ['ES256'] },
        { publicKey: rs.pem, audience: AUD, algorithms: [] },
        { secret: SECRET, audience: AUD, algorithms: ['none' as never] },
        { secret: SECRET, audience: AUD, clockToleranceSec: 3600 },
        { jwksUrl: 'http://keys.example.test/jwks.json', audience: AUD }, // plain http off localhost
        { jwksUrl: 'https://keys.example.test/jwks.json', audience: AUD, algorithms: ['HS256'] }, // HMAC from a key set
        { publicKey: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----', audience: AUD },
        { publicKey: { kty: 'oct', k: 'c2VjcmV0' }, audience: AUD },
        { secret: SECRET, audience: '' },
      ];
      for (const options of cases) expect(invalid(() => jwt(options)), JSON.stringify(options)).toBe('LOUSHO_AUTH_CONFIG_INVALID');
    });
  });
});

describe('verifyJwt (N10a)', () => {
  const checks: JwtChecks = { algorithms: ['HS256'], issuer: ISS, audience: AUD };

  it("rejects alg 'none' in any casing, even when the signature part is empty or junk", async () => {
    const source = await secretSource();
    expect(await rejection(verifyJwt(unsignedToken({ iss: ISS, aud: AUD }), source, { ...checks, algorithms: ['HS256'] }))).toBe('alg-none');
    const shouting = `${base64url(JSON.stringify({ alg: 'NONE' }))}.${base64url(JSON.stringify({ sub: 'u1', exp: nowSec() + 60 }))}.AAAA`;
    expect(await rejection(verifyJwt(shouting, source, checks))).toBe('alg-none');
    // An empty signature segment is malformed before alg is even read.
    expect(await rejection(verifyJwt(unsignedToken({}, ''), source, checks))).toBe('malformed');
    expect(await jwt({ secret: SECRET, audience: AUD })(bearer(unsignedToken({ aud: AUD })))).toBeNull();
  });

  it('rejects an alg outside the configured algorithms', async () => {
    const hs512 = await hmacKey(SECRET, 'HS512');
    expect(await rejection(verifyJwt(await signToken(hs512, { iss: ISS, aud: AUD }), await secretSource(), checks))).toBe('alg-not-allowed');
    expect(await jwt({ secret: SECRET, audience: AUD, algorithms: ['HS256'] })(bearer(await signToken(hs512, { aud: AUD })))).toBeNull();
  });

  it('refuses algorithm confusion: an HS256 token signed with the RSA public key as its secret', async () => {
    const rs = await rsaKey();
    const forged = await signToken(await hmacKey(rs.pem), { iss: ISS, aud: AUD });
    // jwt({ publicKey }) only ever allows RS algorithms, so the header's HS256 is not allowed ...
    expect(await jwt({ publicKey: rs.pem, issuer: ISS, audience: AUD })(bearer(forged))).toBeNull();
    // ... and even a check list that allowed HS256 finds no HMAC key in an RSA key source.
    const rsaSource: KeySource = { keys: async () => [{ kty: 'RSA', importFor: () => Promise.reject(new Error('never imported as HMAC')) }] };
    expect(await rejection(verifyJwt(forged, rsaSource, { ...checks, algorithms: ['HS256', 'RS256'] }))).toBe('no-key');
  });

  it('rejects a bad signature, and a token signed by another key', async () => {
    const hs = await hmacKey();
    const token = await signToken(hs, { iss: ISS, aud: AUD });
    const [head, body] = token.split('.');
    const tampered = `${head}.${base64url(JSON.stringify({ sub: 'admin', iss: ISS, aud: AUD, exp: nowSec() + 600 }))}.${token.split('.')[2]}`;
    expect(await rejection(verifyJwt(tampered, await secretSource(), checks))).toBe('bad-signature');
    expect(await rejection(verifyJwt(`${head}.${body}.${base64url('x'.repeat(32))}`, await secretSource(), checks))).toBe('bad-signature');
    const other = await signToken(await hmacKey('another-secret-that-is-also-long-enough'), { iss: ISS, aud: AUD });
    expect(await rejection(verifyJwt(other, await secretSource(), checks))).toBe('bad-signature');
    const es = await ecKey();
    const esOther = await ecKey();
    expect(await jwt({ publicKey: es.pem, audience: AUD })(bearer(await signToken(esOther, { aud: AUD })))).toBeNull();
  });

  it('checks exp (required), nbf and iat with the clock tolerance', async () => {
    const hs = await hmacKey();
    const source = await secretSource();
    const verdict = async (claims: Record<string, unknown>, tolerance?: number) =>
      rejection(verifyJwt(await signToken(hs, { iss: ISS, aud: AUD, ...claims }), source, { ...checks, ...(tolerance !== undefined && { clockToleranceSec: tolerance }) }));
    expect(await verdict({ exp: undefined })).toBe('missing-exp');
    expect(await verdict({ exp: 'tomorrow' })).toBe('malformed');
    expect(await verdict({ exp: nowSec() - 120 })).toBe('expired');
    expect(await verdict({ exp: nowSec() - 30 })).toBe('accepted'); // within the default 60 s
    expect(await verdict({ exp: nowSec() - 30 }, 0)).toBe('expired');
    expect(await verdict({ nbf: nowSec() + 120 })).toBe('not-yet-valid');
    expect(await verdict({ nbf: nowSec() + 30 })).toBe('accepted');
    expect(await verdict({ iat: nowSec() + 120 })).toBe('issued-in-future');
  });

  it('checks the issuer exactly and the audience', async () => {
    const hs = await hmacKey();
    const source = await secretSource();
    const verdict = async (claims: Record<string, unknown>) => rejection(verifyJwt(await signToken(hs, claims), source, checks));
    expect(await verdict({ iss: `${ISS}/`, aud: AUD })).toBe('wrong-issuer');
    expect(await verdict({ aud: AUD })).toBe('wrong-issuer');
    expect(await verdict({ iss: ISS, aud: 'someone-else' })).toBe('wrong-audience');
    expect(await verdict({ iss: ISS })).toBe('wrong-audience');
    expect(await verdict({ iss: ISS, aud: ['x', AUD] })).toBe('accepted');
  });

  it('refuses malformed tokens, oversized tokens and a crit header', async () => {
    const hs = await hmacKey();
    const source = await secretSource();
    for (const token of ['a.b', 'a.b.c.d', '!!.??.**', `${base64url('[1]')}.${base64url('{}')}.AAAA`, 'x'.repeat(20_000)]) {
      expect(await rejection(verifyJwt(token, source, checks)), token.slice(0, 20)).toBe('malformed');
    }
    expect(await rejection(verifyJwt(await signToken(hs, { iss: ISS, aud: AUD }, { crit: ['exp'] }), source, checks))).toBe('crit');
  });

  it('never fetches a key-set URL named by the token (jku, x5u, jwk headers are ignored)', async () => {
    const rs = await rsaKey();
    const configured = 'https://keys.example.test/jwks.json';
    const fetch = fakeFetch({ [configured]: { keys: [{ ...rs.jwk, kid: 'k1' }] } });
    const auth = jwt({ jwksUrl: configured, audience: AUD, fetch });
    const attacker = await rsaKey();
    const token = await signToken(attacker, { aud: AUD }, { kid: 'evil', jku: 'https://evil.test/jwks.json', x5u: 'https://evil.test/cert.pem', jwk: attacker.jwk });
    expect(await auth(bearer(token))).toBeNull();
    expect(fetch.urls.every((url) => url === configured)).toBe(true);
    expect(await auth(bearer(await signToken(rs, { aud: AUD }, { kid: 'k1' })))).toMatchObject({ id: 'u1' });
  });

  it('refuses an RSA key shorter than 2048 bits', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const weak = await rsaKey(1024);
    expect(await jwt({ publicKey: weak.jwk, audience: AUD })(bearer(await signToken(weak, { aud: AUD })))).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be imported'));
  });
});

describe('jwksKeySource (N10a)', () => {
  const URL_ = 'https://keys.example.test/jwks.json';

  it('fetches once, caches for 10 minutes, and refetches an unknown kid at most once per 30 s', async () => {
    const k1 = await rsaKey();
    const k2 = await rsaKey();
    const documents: Record<string, unknown> = { [URL_]: { keys: [{ ...k1.jwk, kid: 'k1' }] } };
    const fetch = fakeFetch(documents);
    let clock = 1_000_000;
    const source = jwksKeySource(URL_, fetch, () => clock);
    const checks: JwtChecks = { algorithms: ['RS256'], audience: AUD };
    const verify = async (key: SigningKey, kid: string) => rejection(verifyJwt(await signToken(key, { aud: AUD }, { kid }), source, checks));

    expect(await verify(k1, 'k1')).toBe('accepted');
    expect(await verify(k1, 'k1')).toBe('accepted');
    expect(fetch.urls).toHaveLength(1);

    // The key set rotates; an unknown kid triggers one refetch ...
    documents[URL_] = { keys: [{ ...k1.jwk, kid: 'k1' }, { ...k2.jwk, kid: 'k2' }] };
    clock += 31_000;
    expect(await verify(k2, 'k2')).toBe('accepted');
    expect(fetch.urls).toHaveLength(2);

    // ... but a burst of unknown kids within 30 s does not refetch again.
    expect(await verify(k2, 'k3')).toBe('no-key');
    expect(await verify(k2, 'k4')).toBe('no-key');
    expect(fetch.urls).toHaveLength(2);
    clock += 31_000;
    expect(await verify(k2, 'k5')).toBe('no-key');
    expect(fetch.urls).toHaveLength(3);

    // Known kids are served from the cache until it is 10 minutes old.
    clock += 9 * 60_000;
    expect(await verify(k1, 'k1')).toBe('accepted');
    expect(fetch.urls).toHaveLength(3);
    clock += 60_000;
    expect(await verify(k1, 'k1')).toBe('accepted');
    expect(fetch.urls).toHaveLength(4);
  });

  it('concurrent first requests share one fetch and all see the keys', async () => {
    const rs = await rsaKey();
    const fetch = fakeFetch({ [URL_]: { keys: [{ ...rs.jwk, kid: 'k1' }] } });
    const source = jwksKeySource(URL_, fetch, () => 0);
    const token = await signToken(rs, { aud: AUD }, { kid: 'k1' });
    const verdicts = await Promise.all([1, 2, 3].map(() => rejection(verifyJwt(token, source, { algorithms: ['RS256'], audience: AUD }))));
    expect(verdicts).toEqual(['accepted', 'accepted', 'accepted']);
    expect(fetch.urls).toHaveLength(1);
  });

  it('never takes an HMAC key, a non-signing key or a key without verify from a key set', async () => {
    const rs = await rsaKey();
    const fetch = fakeFetch({
      [URL_]: {
        keys: [
          { kty: 'oct', k: base64url(SECRET), kid: 'h' },
          { ...rs.jwk, kid: 'enc', use: 'enc' },
          { ...rs.jwk, kid: 'ops', key_ops: ['encrypt'] },
        ],
      },
    });
    const source = jwksKeySource(URL_, fetch, () => 0);
    expect(await source.keys(undefined)).toEqual([]);
    const hs = await hmacKey();
    expect(await rejection(verifyJwt(await signToken(hs, { aud: AUD }, { kid: 'h' }), source, { algorithms: ['HS256', 'RS256'], audience: AUD }))).toBe('no-key');
  });

  it('a failing endpoint is retried at most every 30 s, and tokens are refused meanwhile', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = fakeFetch({});
    let clock = 0;
    const source = jwksKeySource(URL_, fetch, () => clock);
    expect(await source.keys('k1')).toEqual([]);
    expect(await source.keys('k1')).toEqual([]);
    expect(fetch.urls).toHaveLength(1);
    clock += 30_000;
    await source.keys('k1');
    expect(fetch.urls).toHaveLength(2);
  });

  it('jwt({ jwksUrl }) defaults to RS256 and ES256 and verifies an ES256 key from the set', async () => {
    const es = await ecKey();
    const fetch = fakeFetch({ [URL_]: { keys: [{ ...es.jwk, kid: 'e1', alg: 'ES256' }] } });
    const auth = jwt({ jwksUrl: URL_, issuer: ISS, audience: AUD, fetch });
    expect(await auth(bearer(await signToken(es, { iss: ISS, aud: AUD }, { kid: 'e1' })))).toMatchObject({ id: 'u1', issuer: ISS });
  });
});
