/**
 * The contract every `OAuthTokenStore` keeps (N9a), run against the memory,
 * file, SQLite and KV stores. `make` returns a fresh, empty store whose
 * persistent implementations already have a token key.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OAuthToken, OAuthTokenStore, PendingSignIn, TokenOwner } from './types';

/** Token values the tests look for in every output: they must never appear outside `get()`. */
export const SENTINEL_ACCESS = 'sentinel-access-7c1f0e9a';
export const SENTINEL_REFRESH = 'sentinel-refresh-4b2d8c63';

export const sentinelToken = (): OAuthToken => ({
  accessToken: SENTINEL_ACCESS,
  refreshToken: SENTINEL_REFRESH,
  tokenType: 'Bearer',
  expiresAt: 1_900_000_000_000,
  scope: 'repo read:user',
});

const APP: TokenOwner = { owner: 'app' };
const ALICE: TokenOwner = { owner: 'user', principalId: 'alice' };
const STATE = 'state-0123456789abcdef';

const pending = (overrides: Partial<PendingSignIn> = {}): PendingSignIn => ({
  provider: 'github',
  owner: ALICE,
  codeVerifier: 'verifier-xyz',
  redirectUri: 'https://app.example.com/oauth/callback',
  approvalId: 'ap-1',
  createdAt: 1_800_000_000_000,
  data: { returnTo: '/chat' },
  ...overrides,
});

/** The message, `cause` chain and stack of a rejected promise, or `''` when it resolved. */
export async function errorText(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    while (current) {
      parts.push(String(current), (current as Error).stack ?? '', JSON.stringify(current));
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join('\n');
  }
}

export function describeTokenStoreContract(name: string, make: () => OAuthTokenStore | Promise<OAuthTokenStore>): void {
  describe(`OAuthTokenStore contract: ${name}`, () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('sets, gets, replaces and deletes a token', async () => {
      const store = await make();
      expect(await store.get('github', APP)).toBeUndefined();
      await store.set('github', APP, sentinelToken());
      expect(await store.get('github', APP)).toEqual(sentinelToken());
      await store.set('github', APP, { accessToken: 'second' });
      expect(await store.get('github', APP)).toEqual({ accessToken: 'second' });
      await store.delete('github', APP);
      expect(await store.get('github', APP)).toBeUndefined();
      await expect(store.delete('github', APP)).resolves.toBeUndefined();
    });

    it('returns a copy and keeps only the known token fields', async () => {
      const store = await make();
      await store.set('github', APP, { ...sentinelToken(), extra: 'dropped' } as OAuthToken);
      const read = (await store.get('github', APP))!;
      expect(read).toEqual(sentinelToken());
      read.accessToken = 'changed';
      expect((await store.get('github', APP))?.accessToken).toBe(SENTINEL_ACCESS);
    });

    it('round-trips a registered client with setClient / getClient', async () => {
      const store = await make();
      expect(await store.getClient('github')).toBeUndefined();
      const client = { client_id: 'abc', client_secret: 'shh', redirect_uris: ['https://app.example.com/cb'] };
      await store.setClient('github', client);
      expect(await store.getClient('github')).toEqual(client);
      expect(await store.getClient('gitlab')).toBeUndefined();
    });

    it('keeps app, user and client records of one provider apart, and providers apart', async () => {
      const store = await make();
      const owners: TokenOwner[] = [
        APP,
        { owner: 'user', principalId: 'app' },
        { owner: 'user', principalId: 'client' },
        { owner: 'user', principalId: 'a|b' },
        { owner: 'user', principalId: 'b', issuer: 'a' },
        { owner: 'user', principalId: '%7C' },
        { owner: 'user', principalId: '|' },
      ];
      await store.setClient('github', { client_id: 'client-record' });
      for (const [index, owner] of owners.entries()) await store.set('github', owner, { accessToken: `token-${index}` });
      await store.set('gitlab', APP, { accessToken: 'other-provider' });

      const read = await Promise.all(owners.map((owner) => store.get('github', owner)));
      expect(read.map((token) => token?.accessToken)).toEqual(owners.map((_, index) => `token-${index}`));
      expect(await store.getClient('github')).toEqual({ client_id: 'client-record' });
      expect((await store.get('gitlab', APP))?.accessToken).toBe('other-provider');
      expect(await store.get('gitlab', ALICE)).toBeUndefined();
    });

    it('makes the issuer part of a user key', async () => {
      const store = await make();
      await store.set('github', { owner: 'user', principalId: 'u1', issuer: 'https://a.example.com' }, { accessToken: 'from-a' });
      await store.set('github', { owner: 'user', principalId: 'u1', issuer: 'https://b.example.com' }, { accessToken: 'from-b' });
      await store.set('github', { owner: 'user', principalId: 'u1' }, { accessToken: 'no-issuer' });
      expect((await store.get('github', { owner: 'user', principalId: 'u1', issuer: 'https://a.example.com' }))?.accessToken).toBe('from-a');
      expect((await store.get('github', { owner: 'user', principalId: 'u1', issuer: 'https://b.example.com' }))?.accessToken).toBe('from-b');
      expect((await store.get('github', { owner: 'user', principalId: 'u1' }))?.accessToken).toBe('no-issuer');
    });

    it('lists metadata only, filtered by provider and owner, without clients', async () => {
      const store = await make();
      await store.set('github', ALICE, sentinelToken());
      await store.set('github', APP, { accessToken: SENTINEL_ACCESS });
      await store.set('gitlab', ALICE, { accessToken: SENTINEL_ACCESS, scope: 'api' });
      await store.setClient('github', { client_id: 'abc' });

      const all = await store.list();
      expect(JSON.stringify(all)).not.toContain(SENTINEL_ACCESS);
      expect(JSON.stringify(all)).not.toContain(SENTINEL_REFRESH);
      expect(all.map((info) => [info.provider, info.owner])).toEqual(
        expect.arrayContaining([
          ['github', ALICE],
          ['github', APP],
          ['gitlab', ALICE],
        ])
      );
      expect(all).toHaveLength(3);
      const [alice] = await store.list({ provider: 'github', owner: ALICE });
      expect(alice).toEqual({
        provider: 'github',
        owner: ALICE,
        tokenType: 'Bearer',
        expiresAt: 1_900_000_000_000,
        scope: 'repo read:user',
        hasRefreshToken: true,
        updatedAt: expect.any(Number),
      });
      expect((await store.list({ provider: 'github' })).map((info) => info.owner)).toEqual(expect.arrayContaining([APP, ALICE]));
      expect(await store.list({ provider: 'github' })).toHaveLength(2);
      expect((await store.list({ owner: ALICE })).map((info) => info.provider).sort()).toEqual(['github', 'gitlab']);
      expect(await store.list({ provider: 'nothing-here' })).toEqual([]);
    });

    it('takePending returns a pending sign-in once, then undefined', async () => {
      const store = await make();
      await store.putPending(STATE, pending(), 60_000);
      expect(await store.takePending(STATE)).toEqual(pending());
      expect(await store.takePending(STATE)).toBeUndefined();
      expect(await store.takePending('state-never-stored-000')).toBeUndefined();
    });

    it('an expired pending sign-in is gone', async () => {
      const store = await make();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
      await store.putPending(STATE, pending(), 1_000);
      await store.putPending(`${STATE}-2`, pending({ provider: 'gitlab' }), 120_000);
      vi.setSystemTime(new Date('2026-10-02T12:00:02Z'));
      expect(await store.takePending(STATE)).toBeUndefined();
      expect((await store.takePending(`${STATE}-2`))?.provider).toBe('gitlab');
    });

    it('refuses bad provider names, owners, states and ttls; a malformed callback state is just not found', async () => {
      const store = await make();
      await expect(store.get('git hub', APP)).rejects.toThrow(/Invalid OAuth provider name/);
      await expect(store.set('a|b', APP, { accessToken: SENTINEL_ACCESS })).rejects.toThrow(/Invalid OAuth provider name/);
      await expect(store.setClient('../x', {})).rejects.toThrow(/Invalid OAuth provider name/);
      await expect(store.get('github', { owner: 'user', principalId: '' })).rejects.toThrow(/principalId/);
      await expect(store.get('github', { owner: 'user', principalId: 'u', issuer: '' })).rejects.toThrow(/issuer/);
      await expect(store.get('github', { owner: 'someone' } as unknown as TokenOwner)).rejects.toThrow(/Invalid token owner/);
      await expect(store.set('github', APP, { accessToken: '' })).rejects.toThrow(/accessToken/);
      await expect(store.putPending('short', pending(), 1_000)).rejects.toThrow(/Invalid sign-in state/);
      await expect(store.putPending('../../etc/passwd-xxxxxxx', pending(), 1_000)).rejects.toThrow(/Invalid sign-in state/);
      await expect(store.putPending(STATE, pending(), 0)).rejects.toThrow(/ttlMs/);
      await expect(store.putPending(STATE, pending({ provider: 'no good' }), 1_000)).rejects.toThrow(/provider/);
      expect(await store.takePending('../../etc/passwd-xxxxxxx')).toBeUndefined();
      await expect(store.list({ provider: 'bad name' })).rejects.toThrow(/Invalid OAuth provider name/);
    });

    it('never puts a token into an error it throws', async () => {
      const store = await make();
      const texts = await Promise.all([
        errorText(store.set('bad provider', APP, sentinelToken())),
        errorText(store.set('github', { owner: 'nobody' } as unknown as TokenOwner, sentinelToken())),
        errorText(store.set('github', APP, { refreshToken: SENTINEL_REFRESH } as OAuthToken)),
        errorText(store.putPending('bad', pending({ codeVerifier: SENTINEL_REFRESH }), 1_000)),
      ]);
      for (const text of texts) {
        expect(text).not.toBe('');
        expect(text).not.toContain(SENTINEL_ACCESS);
        expect(text).not.toContain(SENTINEL_REFRESH);
      }
    });
  });
}
