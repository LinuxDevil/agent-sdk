import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MAX_SERVE_ORIGINS,
  ServeConfigInvalidError,
  ServeConfigStore,
  normalizeServeOrigin,
} from '../serve/serveConfigStore';

describe('ServeConfigStore', () => {
  let dir: string;
  let store: ServeConfigStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-x02a-servecfg-'));
    store = new ServeConfigStore(path.join(dir, 'serve.json'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a disabled entry with a minted token on first read', async () => {
    const entry = await store.get('ops');
    expect(entry.enabled).toBe(false);
    expect(entry.allowedOrigins).toEqual([]);
    expect(entry.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // The file on disk carries the same entry under agents.ops.
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'serve.json'), 'utf8'));
    expect(file.schemaVersion).toBe(1);
    expect(file.agents.ops.token).toBe(entry.token);
  });

  it('returns the same token on a second read (no re-mint)', async () => {
    const first = await store.get('ops');
    const second = await store.get('ops');
    expect(second.token).toBe(first.token);
  });

  it('put patches enabled and allowedOrigins independently', async () => {
    await store.put('ops', { enabled: true });
    let entry = await store.get('ops');
    expect(entry.enabled).toBe(true);
    expect(entry.allowedOrigins).toEqual([]);

    await store.put('ops', { allowedOrigins: ['https://app.example'] });
    entry = await store.get('ops');
    expect(entry.enabled).toBe(true);
    expect(entry.allowedOrigins).toEqual(['https://app.example']);

    await store.put('ops', { enabled: false });
    entry = await store.get('ops');
    expect(entry.enabled).toBe(false);
    expect(entry.allowedOrigins).toEqual(['https://app.example']);
  });

  it('rotateToken replaces the bearer and keeps the rest', async () => {
    await store.put('ops', { enabled: true, allowedOrigins: ['https://app.example'] });
    const before = await store.get('ops');
    const token = await store.rotateToken('ops');
    expect(token).not.toBe(before.token);
    const after = await store.get('ops');
    expect(after.token).toBe(token);
    expect(after.enabled).toBe(true);
    expect(after.allowedOrigins).toEqual(['https://app.example']);
  });

  it('keeps agents isolated in one file', async () => {
    await store.put('ops', { enabled: true });
    await store.put('billing', { allowedOrigins: ['https://billing.example'] });
    expect((await store.get('ops')).enabled).toBe(true);
    expect((await store.get('billing')).enabled).toBe(false);
  });

  it('serializes concurrent puts so neither patch is lost', async () => {
    await Promise.all([
      store.put('ops', { enabled: true }),
      store.put('ops', { allowedOrigins: ['https://a.example'] }),
    ]);
    const entry = await store.get('ops');
    expect(entry.enabled).toBe(true);
    expect(entry.allowedOrigins).toEqual(['https://a.example']);
  });

  it.each([
    ['not a url', 'nope'],
    ['a path', 'https://app.example/chat'],
    ['a query', 'https://app.example/?x=1'],
    ['a non-http scheme', 'ftp://app.example'],
    ['a bare host', 'app.example'],
  ])('rejects %s as an origin', async (_label, origin) => {
    await expect(store.put('ops', { allowedOrigins: [origin] })).rejects.toBeInstanceOf(ServeConfigInvalidError);
  });

  it('rejects more than MAX_SERVE_ORIGINS entries', async () => {
    const origins = Array.from({ length: MAX_SERVE_ORIGINS + 1 }, (_, i) => `https://o${i}.example`);
    await expect(store.put('ops', { allowedOrigins: origins })).rejects.toBeInstanceOf(ServeConfigInvalidError);
  });

  it('normalizes origin casing, trailing slash and dedupes', async () => {
    const entry = await store.put('ops', {
      allowedOrigins: ['HTTPS://APP.Example/', 'https://app.example', 'http://localhost:5173'],
    });
    expect(entry.allowedOrigins).toEqual(['https://app.example', 'http://localhost:5173']);
  });
});

describe('normalizeServeOrigin', () => {
  it.each([
    ['https://app.example', 'https://app.example'],
    ['https://app.example/', 'https://app.example'],
    ['HTTP://LOCALHOST:5173', 'http://localhost:5173'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeServeOrigin(raw)).toBe(expected);
  });

  it.each([['https://app.example/x'], ['https://app.example?y=2'], ['ws://app.example'], ['javascript:alert(1)']])(
    'rejects %s',
    (raw) => {
      expect(normalizeServeOrigin(raw)).toBeNull();
    }
  );
});
