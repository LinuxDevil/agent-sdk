/**
 * N9a: `AgentStore.tokens` on every shipped store. The shared contract runs
 * against memoryStore(), fileStore(), SqliteStore and KVStore; the rest checks
 * what only persistent stores do: encryption at rest, the key, migrations.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryStore } from '../storage/agentStore';
import { fileStore } from '../storage/fileStore';
import { SqliteStore } from '../storage/sqlite';
import { migrate, MIGRATIONS } from '../storage/sqlite/migrations';
import { loadDatabaseSync } from '../storage/sqlite/driver';
import { KVStore } from '../deploy/kvStore';
import type { KVBinding, KVListOptions, KVPutOptions } from '../deploy/kvCheckpointStore';
import { generateTokenKey, tokenStoreKey, type OAuthTokenStore, type TokenOwner } from './index';
import { describeTokenStoreContract, errorText, SENTINEL_ACCESS, SENTINEL_REFRESH, sentinelToken } from './tokenStore.contract';

const KEY = generateTokenKey();
const APP: TokenOwner = { owner: 'app' };
const STATE = 'state-0123456789abcdef';

const dirs: string[] = [];
const sqliteStores: SqliteStore[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-oauth-'));
  dirs.push(dir);
  return dir;
}
function sqlite(options: ConstructorParameters<typeof SqliteStore>[1] = { tokenKey: KEY }, file = ':memory:'): SqliteStore {
  const store = new SqliteStore(file, options);
  sqliteStores.push(store);
  return store;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const store of sqliteStores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An in-memory KV namespace with list() pages of two keys, and the ttl of each put. */
function fakeKV(withList = true) {
  const data = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const kv: KVBinding = {
    get: async (key) => data.get(key) ?? null,
    put: async (key, value, options?: KVPutOptions) => {
      data.set(key, value);
      ttls.set(key, options?.expirationTtl);
    },
    delete: async (key) => void data.delete(key),
  };
  if (withList) {
    kv.list = async ({ prefix = '', cursor }: KVListOptions) => {
      const names = [...data.keys()].filter((name) => name.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const end = start + 2;
      return { keys: names.slice(start, end).map((name) => ({ name })), list_complete: end >= names.length, cursor: String(end) };
    };
  }
  return { kv, data, ttls };
}

describeTokenStoreContract('memoryStore().tokens', () => memoryStore().tokens);
describeTokenStoreContract('fileStore(dir).tokens', () => fileStore(tempDir(), { tokenKey: KEY }).tokens);
describeTokenStoreContract('SqliteStore.tokens', () => sqlite().tokens);
describeTokenStoreContract('KVStore.tokens', () => new KVStore(fakeKV().kv, { tokenKey: KEY, prefix: 'app/' }).tokens);

/** Every persistent store, with a way to read everything it wrote, raw. */
const persistent: Array<{ name: string; make: (tokenKey?: string) => { tokens: OAuthTokenStore; raw: () => string } }> = [
  {
    name: 'fileStore',
    make: (tokenKey) => {
      const dir = tempDir();
      const raw = (): string => {
        const read = (path: string): string[] =>
          readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
            entry.isDirectory() ? read(join(path, entry.name)) : [readFileSync(join(path, entry.name), 'utf8')]
          );
        try {
          return read(dir).join('\n');
        } catch {
          return '';
        }
      };
      return { tokens: fileStore(dir, { tokenKey }).tokens, raw };
    },
  },
  {
    name: 'SqliteStore',
    make: (tokenKey) => {
      const store = sqlite({ tokenKey });
      const raw = (): string => {
        const db = store.connection.db;
        const rows = [...db.prepare('SELECT key, payload FROM oauth_tokens').all(), ...db.prepare('SELECT state, payload FROM oauth_pending').all()];
        return JSON.stringify(rows);
      };
      return { tokens: store.tokens, raw };
    },
  },
  {
    name: 'KVStore',
    make: (tokenKey) => {
      const { kv, data } = fakeKV();
      return { tokens: new KVStore(kv, { tokenKey }).tokens, raw: () => JSON.stringify([...data]) };
    },
  },
];

describe.each(persistent)('$name tokens at rest (N9a)', ({ make }) => {
  it('stores no access token, refresh token, PKCE verifier or client secret in plaintext', async () => {
    const { tokens, raw } = make(KEY);
    await tokens.set('github', { owner: 'user', principalId: 'alice', issuer: 'https://id.example.com' }, sentinelToken());
    await tokens.set('github', APP, sentinelToken());
    await tokens.setClient('github', { client_id: 'abc', client_secret: SENTINEL_REFRESH });
    await tokens.putPending(STATE, { provider: 'github', owner: APP, codeVerifier: SENTINEL_ACCESS, redirectUri: 'https://x.example/cb', createdAt: 1 }, 60_000);
    const stored = raw();
    expect(stored).toMatch(/v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+/);
    expect(stored).not.toContain(SENTINEL_ACCESS);
    expect(stored).not.toContain(SENTINEL_REFRESH);
    expect(stored).not.toContain('repo read:user'); // the scope is inside the sealed record too
  });

  it('throws LOUSHO_TOKEN_KEY_MISSING on the first write without a key; reads of nothing need no key', async () => {
    vi.stubEnv('LOUSHO_TOKEN_KEY', '');
    const { tokens } = make(undefined);
    expect(await tokens.get('github', APP)).toBeUndefined();
    expect(await tokens.getClient('github')).toBeUndefined();
    expect(await tokens.takePending(STATE)).toBeUndefined();
    expect(await tokens.list()).toEqual([]);
    await expect(tokens.delete('github', APP)).resolves.toBeUndefined();
    for (const write of [
      tokens.set('github', APP, sentinelToken()),
      tokens.setClient('github', { client_id: 'abc' }),
      tokens.putPending(STATE, { provider: 'github', owner: APP, redirectUri: 'https://x.example/cb', createdAt: 1 }, 60_000),
    ]) {
      await expect(write).rejects.toMatchObject({ code: 'LOUSHO_TOKEN_KEY_MISSING' });
    }
    const text = await errorText(tokens.set('github', APP, sentinelToken()));
    expect(text).toMatch(/no OAuth token key/);
    expect(text).not.toContain(SENTINEL_ACCESS);
    expect(text).not.toContain(SENTINEL_REFRESH);
  });

  it('uses LOUSHO_TOKEN_KEY when no tokenKey is given', async () => {
    vi.stubEnv('LOUSHO_TOKEN_KEY', KEY);
    const { tokens } = make(undefined);
    await tokens.set('github', APP, sentinelToken());
    expect(await tokens.get('github', APP)).toEqual(sentinelToken());
  });

  it('refuses a malformed tokenKey when the store is built', () => {
    expect(() => make('too-short')).toThrow(/must be 32 random bytes as base64/);
  });
});

describe('a stored token read with the wrong key, or with none', () => {
  it('throws LOUSHO_TOKEN_DECRYPT_FAILED naming the provider, never the token (SQLite file)', async () => {
    const file = join(tempDir(), 'agent.db');
    const writer = sqlite({ tokenKey: KEY }, file);
    await writer.tokens.set('github', APP, sentinelToken());
    await writer.tokens.setClient('github', { client_secret: SENTINEL_REFRESH });
    writer.close();

    const wrong = sqlite({ tokenKey: generateTokenKey() }, file);
    await expect(wrong.tokens.get('github', APP)).rejects.toMatchObject({ code: 'LOUSHO_TOKEN_DECRYPT_FAILED' });
    await expect(wrong.tokens.getClient('github')).rejects.toMatchObject({ code: 'LOUSHO_TOKEN_DECRYPT_FAILED' });
    await expect(wrong.tokens.list()).rejects.toMatchObject({ code: 'LOUSHO_TOKEN_DECRYPT_FAILED' });
    const text = await errorText(wrong.tokens.get('github', APP));
    expect(text).toContain('provider "github"');
    expect(text).not.toContain(SENTINEL_ACCESS);
    expect(text).not.toContain(SENTINEL_REFRESH);
    expect(text).not.toContain(KEY);

    vi.stubEnv('LOUSHO_TOKEN_KEY', '');
    const none = sqlite({}, file);
    await expect(none.tokens.get('github', APP)).rejects.toMatchObject({ code: 'LOUSHO_TOKEN_KEY_MISSING' });

    const rotated = sqlite({ tokenKey: [generateTokenKey(), KEY] }, file);
    expect(await rotated.tokens.get('github', APP)).toEqual(sentinelToken());
  });

  it('a sealed row copied onto another owner does not decrypt (the key is the AAD)', async () => {
    const store = sqlite();
    await store.tokens.set('github', { owner: 'user', principalId: 'alice' }, sentinelToken());
    const db = store.connection.db;
    const { payload } = db.prepare('SELECT payload FROM oauth_tokens WHERE key = ?').get(tokenStoreKey('github', { owner: 'user', principalId: 'alice' }))!;
    db.prepare('INSERT INTO oauth_tokens (key, payload, updated_at) VALUES (?, ?, ?)').run(tokenStoreKey('github', { owner: 'user', principalId: 'mallory' }), payload, 1);
    await expect(store.tokens.get('github', { owner: 'user', principalId: 'mallory' })).rejects.toMatchObject({ code: 'LOUSHO_TOKEN_DECRYPT_FAILED' });
  });

  it('KV: a sealed value copied onto another key does not decrypt either', async () => {
    const { kv, data } = fakeKV();
    const { tokens } = new KVStore(kv, { tokenKey: KEY });
    await tokens.set('github', APP, sentinelToken());
    data.set('oauth/tokens/github|client', data.get('oauth/tokens/github|app')!);
    await expect(tokens.getClient('github')).rejects.toMatchObject({ code: 'LOUSHO_TOKEN_DECRYPT_FAILED' });
  });
});

describe('tokenStoreKey', () => {
  it('is <provider>|app or <provider>|user|<issuer>|<principalId>, percent-encoded', () => {
    expect(tokenStoreKey('github', APP)).toBe('github|app');
    expect(tokenStoreKey('github', { owner: 'user', principalId: 'u-1' })).toBe('github|user||u-1');
    expect(tokenStoreKey('github', { owner: 'user', principalId: 'a|b', issuer: 'https://id.example.com' })).toBe(
      'github|user|https%3A%2F%2Fid.example.com|a%7Cb'
    );
  });
});

describe('SqliteStore oauth tables (N9a)', () => {
  it('a database at the previous user_version opens and gains both tables', async () => {
    const file = join(tempDir(), 'v3.db');
    const DatabaseSync = loadDatabaseSync();
    const raw = new DatabaseSync(file);
    expect(migrate(raw, MIGRATIONS.slice(0, 3))).toBe(3);
    raw.close();

    const store = sqlite({ tokenKey: KEY }, file);
    await store.tokens.set('github', APP, sentinelToken());
    const tables = store.connection.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'oauth_%' ORDER BY name").all();
    expect(tables.map((row) => row.name)).toEqual(['oauth_pending', 'oauth_tokens']);
    expect(store.connection.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
  });

  it('prune() deletes expired pending rows and keeps live ones and tokens', async () => {
    const store = sqlite();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
      await store.tokens.set('github', APP, sentinelToken());
      await store.tokens.putPending(STATE, { provider: 'github', owner: APP, redirectUri: 'https://x.example/cb', createdAt: 1 }, 1_000);
      await store.tokens.putPending(`${STATE}-live`, { provider: 'github', owner: APP, redirectUri: 'https://x.example/cb', createdAt: 1 }, 600_000);
      vi.setSystemTime(new Date('2026-10-02T12:00:05Z'));
      expect(store.prune({ olderThanMs: 0 })).toMatchObject({ oauthPending: 1 });
      const states = store.connection.db.prepare('SELECT state FROM oauth_pending').all();
      expect(states.map((row) => row.state)).toEqual([`${STATE}-live`]);
      expect(await store.tokens.get('github', APP)).toEqual(sentinelToken());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('KVStore oauth keys (N9a)', () => {
  it('keeps tokens under <prefix>oauth/tokens/ and pending sign-ins under <prefix>oauth/pending/ with an expirationTtl', async () => {
    const { kv, data, ttls } = fakeKV();
    const { tokens } = new KVStore(kv, { tokenKey: KEY, prefix: 'app/' });
    await tokens.set('github', APP, sentinelToken());
    await tokens.putPending(STATE, { provider: 'github', owner: APP, redirectUri: 'https://x.example/cb', createdAt: 1 }, 10_000);
    await tokens.putPending(`${STATE}-long`, { provider: 'github', owner: APP, redirectUri: 'https://x.example/cb', createdAt: 1 }, 600_000);
    expect([...data.keys()].sort()).toEqual(['app/oauth/pending/state-0123456789abcdef', 'app/oauth/pending/state-0123456789abcdef-long', 'app/oauth/tokens/github|app']);
    expect(ttls.get('app/oauth/pending/state-0123456789abcdef')).toBe(60); // KV's minimum; the record's own expiry is exact
    expect(ttls.get('app/oauth/pending/state-0123456789abcdef-long')).toBe(600);
    expect(ttls.get('app/oauth/tokens/github|app')).toBeUndefined();
  });

  it('list() needs a binding with list(); the rest works without it', async () => {
    const { tokens } = new KVStore(fakeKV(false).kv, { tokenKey: KEY });
    await tokens.set('github', APP, sentinelToken());
    expect(await tokens.get('github', APP)).toEqual(sentinelToken());
    await expect(tokens.list()).rejects.toThrow(/needs a KV binding with list\(\)/);
  });
});

describe('fileStore oauth files (N9a)', () => {
  it('names token files by hash and drops expired pending files when a new sign-in starts', async () => {
    const dir = tempDir();
    const { tokens } = fileStore(dir, { tokenKey: KEY });
    await tokens.set('github', { owner: 'user', principalId: 'a/../../b', issuer: 'C:\\x' }, sentinelToken());
    expect(readdirSync(join(dir, 'oauth', 'tokens'))).toEqual([expect.stringMatching(/^[0-9a-f]{64}\.json$/)]);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
      await tokens.putPending(STATE, { provider: 'github', owner: APP, redirectUri: 'https://x.example/cb', createdAt: 1 }, 1_000);
      vi.setSystemTime(new Date('2026-10-02T12:00:05Z'));
      await tokens.putPending(`${STATE}-2`, { provider: 'github', owner: APP, redirectUri: 'https://x.example/cb', createdAt: 1 }, 1_000);
      expect(readdirSync(join(dir, 'oauth', 'pending'))).toEqual([`${STATE}-2.json`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a pending sign-in to exactly one of two concurrent takers', async () => {
    const { tokens } = fileStore(tempDir(), { tokenKey: KEY });
    await tokens.putPending(STATE, { provider: 'github', owner: APP, redirectUri: 'https://x.example/cb', createdAt: 1 }, 60_000);
    const results = await Promise.all([tokens.takePending(STATE), tokens.takePending(STATE)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
