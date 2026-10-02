/** N10a: basic(), apiToken() and anonymous(). */
import { describe, expect, it, vi } from 'vitest';
import { SDKError } from '../utils/sdkError';
import { anonymous, apiToken, basic } from './basic';
import * as encoding from './encoding';

const withBasic = (user: string, password: string) => {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  return new Request('https://agent.test/', { headers: { authorization: `Basic ${btoa(String.fromCharCode(...bytes))}` } });
};

describe('basic() (N10a)', () => {
  const auth = basic({ users: { ops: 'correct horse', 'zoë': 'pässword' }, realm: 'agent' });

  it('accepts the right password as a user principal', async () => {
    expect(await auth(withBasic('ops', 'correct horse'))).toEqual({ id: 'ops', type: 'user', authenticator: 'basic' });
    expect(auth.challenges).toEqual([{ scheme: 'Basic', realm: 'agent' }]);
  });

  it('skips a wrong password, an unknown user, a missing or malformed header', async () => {
    expect(await auth(withBasic('ops', 'wrong'))).toBeNull();
    expect(await auth(withBasic('nobody', 'correct horse'))).toBeNull();
    expect(await auth(new Request('https://agent.test/'))).toBeNull();
    expect(await auth(new Request('https://agent.test/', { headers: { authorization: 'Basic !!!' } }))).toBeNull();
    expect(await auth(new Request('https://agent.test/', { headers: { authorization: `Basic ${btoa('no-colon')}` } }))).toBeNull();
    expect(await auth(new Request('https://agent.test/', { headers: { authorization: 'Bearer ops:correct horse' } }))).toBeNull();
  });

  it('NFC-normalizes user and password (a decomposed ë matches the composed one)', async () => {
    expect(await auth(withBasic('zoë', 'pässword'))).toMatchObject({ id: 'zoë' });
  });

  it('compares in constant time: an unknown user costs the same digest comparisons as a known one', async () => {
    const spy = vi.spyOn(encoding, 'sameDigest');
    await auth(withBasic('ops', 'wrong'));
    const known = spy.mock.calls.length;
    spy.mockClear();
    await auth(withBasic('nobody-at-all', 'wrong'));
    expect(spy.mock.calls.length).toBe(known);
    expect(known).toBe(4); // every configured user, user and password each
    spy.mockRestore();
  });

  it('takes a checker function', async () => {
    const fn = basic({ users: (user, password) => user === 'svc' && password === 'pw' });
    expect(await fn(withBasic('svc', 'pw'))).toEqual({ id: 'svc', type: 'user', authenticator: 'basic' });
    expect(await fn(withBasic('svc', 'nope'))).toBeNull();
  });

  it('refuses unusable users at construction', () => {
    for (const users of [{}, { '': 'x' }, { 'a:b': 'x' }, { a: '' }]) {
      expect(() => basic({ users }), JSON.stringify(users)).toThrow(SDKError);
    }
  });
});

describe('apiToken() and anonymous() (N10a)', () => {
  it('accepts the bearer token as a service principal, in constant time', async () => {
    const auth = apiToken('sekret-token', { id: 'ci' });
    const spy = vi.spyOn(encoding, 'sameSecret');
    const ok = new Request('https://agent.test/', { headers: { authorization: 'Bearer sekret-token' } });
    expect(await auth(ok)).toEqual({ id: 'ci', type: 'service', authenticator: 'api-token' });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(await auth(new Request('https://agent.test/', { headers: { authorization: 'Bearer sekret-token-' } }))).toBeNull();
    expect(await auth(new Request('https://agent.test/'))).toBeNull();
    expect(await apiToken('t')(new Request('https://agent.test/', { headers: { authorization: 'Bearer t' } }))).toMatchObject({ id: 'api-token' });
    expect(() => apiToken('')).toThrow(SDKError);
  });

  it('anonymous() accepts everyone', async () => {
    expect(await anonymous()(new Request('https://agent.test/'))).toEqual({ id: 'anonymous', type: 'user', authenticator: 'anonymous' });
  });
});
