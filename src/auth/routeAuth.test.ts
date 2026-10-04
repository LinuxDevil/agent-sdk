/** N10a: routeAuth(), the ordered list. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build, stop } from 'esbuild';
import { join } from 'node:path';
import { routeAuth } from './routeAuth';
import { AuthError, type AuthFn, type Principal } from './types';
import { anonymous, apiToken, basic } from './basic';
import { jwt } from './jwt';
import * as auth from './index';
import { SECRET, bearer, hmacKey, signToken } from './__fixtures__/tokens';

const request = () => new Request('https://agent.test/chat');
const user = (id: string): Principal => ({ id, type: 'user', authenticator: 'custom' });
const skip: AuthFn = () => null;

afterEach(() => { vi.restoreAllMocks(); });

describe('routeAuth (N10a)', () => {
  it('walks the list in order and the first principal wins', async () => {
    const calls: string[] = [];
    const entry = (name: string, result: Principal | null): AuthFn => () => (calls.push(name), result);
    const outcome = await routeAuth(request(), [entry('a', null), entry('b', user('b')), entry('c', user('c'))]);
    expect(outcome).toEqual({ ok: true, principal: user('b') });
    expect(calls).toEqual(['a', 'b']);
  });

  it('answers 401 with the merged challenges when every entry skips', async () => {
    const outcome = await routeAuth(request(), [jwt({ secret: SECRET, audience: 'x' }), apiToken('t'), basic({ users: { a: 'b' }, realm: 'my "realm"' }), skip]);
    expect(outcome.ok).toBe(false);
    const { response } = outcome as { response: Response };
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('www-authenticate')).toBe('Bearer, Basic realm="my \\"realm\\"", charset="UTF-8"');
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('gives the same generic 401 whatever check failed', async () => {
    const hs = await hmacKey();
    const entries = [jwt({ secret: SECRET, audience: 'agent', issuer: 'https://iss.test' })];
    const bodies = new Set<string>();
    for (const token of [
      await signToken(hs, { aud: 'agent', iss: 'https://iss.test', exp: 1 }),
      await signToken(hs, { aud: 'other', iss: 'https://iss.test' }),
      await signToken(hs, { aud: 'agent', iss: 'https://other.test' }),
      'not-a-jwt',
    ]) {
      const outcome = await routeAuth(bearer(token), entries);
      const { response } = outcome as { response: Response };
      expect(response.status).toBe(401);
      const headerPairs: string[] = [];
      response.headers.forEach((value, key) => headerPairs.push(`${key}=${value}`));
      bodies.add(`${headerPairs.sort().join('|')} ${await response.text()}`);
    }
    expect(bodies.size).toBe(1);
  });

  it('AuthError stops the walk with its status', async () => {
    const forbid: AuthFn = () => {
      throw new AuthError(403, 'tenant suspended');
    };
    const later = vi.fn(anonymous());
    const outcome = await routeAuth(request(), [skip, forbid, later]);
    const { response } = outcome as { response: Response };
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
    expect(later).not.toHaveBeenCalled();
    const unauthorized = await routeAuth(request(), [() => Promise.reject(new AuthError(401))]);
    expect((unauthorized as { response: Response }).response.status).toBe(401);
  });

  it('an unexpected throw is a 500 whose body does not carry the error, and is logged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const outcome = await routeAuth(request(), [
      () => {
        throw new Error('database password is hunter2');
      },
    ]);
    const { response } = outcome as { response: Response };
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('hunter2');
    expect(error).toHaveBeenCalled();
  });

  it('a result that is not a principal is a 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const bad of [true, { id: '' }, { id: 'x', type: 'admin', authenticator: 'c' }]) {
      const outcome = await routeAuth(request(), [() => bad as unknown as Principal]);
      expect((outcome as { response: Response }).response.status).toBe(500);
    }
  });

  it('an empty list rejects everything', async () => {
    const outcome = await routeAuth(request(), []);
    expect((outcome as { response: Response }).response.status).toBe(401);
  });

  it('takes a single entry', async () => {
    expect(await routeAuth(request(), anonymous())).toMatchObject({ ok: true, principal: { id: 'anonymous' } });
  });
});

describe('@lousho/build-ai-agent/auth (N10a)', () => {
  afterEach(() => stop());

  it('exports the helpers', () => {
    expect(Object.keys(auth).sort()).toEqual(['AuthError', 'anonymous', 'apiToken', 'basic', 'jwt', 'oidc', 'routeAuth']);
  });

  it('bundles for the browser platform (Workers, edge routes) with no node: import in its graph', async () => {
    const result = await build({
      entryPoints: [join(__dirname, 'index.ts')],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      metafile: true,
      logLevel: 'silent',
    });
    expect(result.errors).toEqual([]);
    const inputs = Object.entries(result.metafile.inputs);
    expect(inputs.flatMap(([file, input]) => input.imports.filter((entry) => entry.path.startsWith('node:')).map((entry) => `${file} -> ${entry.path}`))).toEqual([]);
    // Small and self-contained: no `ai`, no zod, nothing outside src/auth and the SDK error class.
    expect(inputs.map(([file]) => file).filter((file) => !/src[\\/](auth|utils)[\\/]/.test(file))).toEqual([]);
  }, 30_000);
});
