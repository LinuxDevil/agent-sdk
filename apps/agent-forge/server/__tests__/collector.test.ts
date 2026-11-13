/**
 * The CollectorManager (collector.ts): attach to a running daemon, start
 * one in-process on a loopback URL, report a remote/down one, re-probe,
 * persist the Settings → Collector change and keep the bearer token a
 * secret. The daemon itself is the SDK's `startObserveDaemon` - tests
 * either run a real one on an ephemeral port or inject `startDaemon`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AddressInfo } from 'node:net';
import { startObserveDaemon, type ObserveDaemon } from 'lousho/observe';
import {
  COLLECTOR_TOKEN_SECRET,
  CollectorLockedError,
  CollectorManager,
  CollectorUrlError,
  DEFAULT_COLLECTOR_URL,
  type CollectorDeps,
} from '../collector';
import { SettingsStore } from '../settingsStore';
import { SecretsStore } from '../secretsStore';
import type { CollectorStatus } from '../../shared/wireTypes';

const daemons: ObserveDaemon[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  // `manager.stop()`/`reconfigure` may already have closed a daemon; closing twice throws.
  while (daemons.length > 0) await daemons.pop()?.close().catch(() => {});
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function freePort(): Promise<number> {
  const server = http.createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  servers.splice(servers.indexOf(server), 1);
  return port;
}

/** A `fetch` that answers `/health` like a lousho-observe daemon and records its calls. */
function fakeHealth(version = '9.9.9-test'): { fetchFn: typeof fetch; calls: { url: string; headers: Headers }[] } {
  const calls: { url: string; headers: Headers }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ service: 'lousho-observe', ok: true, version }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('CollectorManager', () => {
  let baseDir: string;
  let settings: SettingsStore;
  let secrets: SecretsStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-collector-test-'));
    settings = new SettingsStore(baseDir);
    secrets = new SecretsStore(baseDir);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function manager(over: Partial<CollectorDeps> = {}): CollectorManager {
    return new CollectorManager({ settings, secrets, env: {}, ...over });
  }

  it('attaches to a daemon already answering at the URL and never closes it', async () => {
    const daemon = await startObserveDaemon({ dbPath: ':memory:', port: 0 });
    daemons.push(daemon);
    const url = `http://127.0.0.1:${daemon.port}`;
    const m = manager({ env: { LOUSHO_OBSERVE_URL: url } });

    const status = await m.start();
    expect(status.mode).toBe('attached');
    expect(status.url).toBe(url);
    expect(status.daemonVersion).toBeTruthy();
    expect(status.error).toBeNull();

    await m.stop();
    // An attached daemon is not ours: it still answers after stop().
    const res = await fetch(`${url}/health`);
    expect(res.ok).toBe(true);
  });

  it('starts a daemon in-process on a loopback URL with nothing there, and stop() closes it', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const seen: { port?: number; pidPath?: string; dbPath?: string } = {};
    const m = manager({
      env: { LOUSHO_OBSERVE_URL: url },
      startDaemon: async (options) => {
        seen.port = options.port;
        seen.pidPath = options.pidPath;
        seen.dbPath = options.dbPath;
        // The test owns the db path so nothing touches ~/.lousho.
        const daemon = await startObserveDaemon({ ...options, dbPath: path.join(baseDir, 'observe.db') });
        daemons.push(daemon);
        return daemon;
      },
    });

    const status = await m.start();
    expect(status.mode).toBe('started');
    expect(status.url).toBe(url);
    expect(status.error).toBeNull();
    expect(seen.port).toBe(port);
    expect(seen.pidPath).toBeUndefined();
    expect(seen.dbPath).toContain('.lousho'); // defaultDbPath(), overridden by the test seam above

    await m.stop();
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });

  it('reports down with the port message when a plain HTTP server holds the loopback port', async () => {
    const port = await freePort();
    const squatter = http.createServer((_req, res) => res.end('not a collector'));
    servers.push(squatter);
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', resolve));

    const m = manager({ env: { LOUSHO_OBSERVE_URL: `http://127.0.0.1:${port}` } });
    const status = await m.start();
    expect(status.mode).toBe('down');
    expect(status.error).toContain(`Port ${port}`);
    expect(status.error).toContain('not a Lousho collector');
  });

  it('probes a remote URL with the bearer token and reports remote', async () => {
    secrets.setSecret(COLLECTOR_TOKEN_SECRET, 's3cret-token');
    const { fetchFn, calls } = fakeHealth();
    const url = 'https://collector.example.com';
    const m = manager({ env: { LOUSHO_OBSERVE_URL: url }, fetchFn });

    const status = await m.start();
    expect(status.mode).toBe('remote');
    expect(status.url).toBe(url);
    expect(status.hasToken).toBe(true);
    expect(status.daemonVersion).toBe('9.9.9-test');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${url}/health`);
    expect(calls[0].headers.get('authorization')).toBe('Bearer s3cret-token');
    // The token never appears in the status the API returns.
    expect(JSON.stringify(status)).not.toContain('s3cret-token');
  });

  it('autoStart: false never starts a daemon, even on a free loopback URL', async () => {
    const port = await freePort();
    const startDaemon = vi.fn();
    const m = manager({
      env: { LOUSHO_OBSERVE_URL: `http://127.0.0.1:${port}` },
      autoStart: false,
      startDaemon: startDaemon as unknown as CollectorDeps['startDaemon'],
    });
    const status = await m.start();
    expect(status.mode).toBe('down');
    expect(startDaemon).not.toHaveBeenCalled();
  });

  it('reconfigure persists the URL, re-probes and notifies onChange', async () => {
    const { fetchFn, calls } = fakeHealth();
    const m = manager({ fetchFn });
    const seen: CollectorStatus[] = [];
    m.onChange((s) => seen.push(s));
    await m.start(); // default loopback is down; the reprobe timer is unref'd

    const url = 'https://collector.example.com';
    const status = await m.reconfigure({ url });
    expect(status.mode).toBe('remote');
    expect(settings.getCollectorUrl()).toBe(url);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)?.mode).toBe('remote');
    expect(calls.at(-1)?.url).toBe(`${url}/health`);

    // Clearing the setting falls back to the loopback default.
    await m.reconfigure({ url: null });
    expect(settings.getCollectorUrl()).toBeNull();
    expect(m.url()).toBe(DEFAULT_COLLECTOR_URL);
  });

  it('token: null removes the named secret; an absent token keeps it', async () => {
    secrets.setSecret(COLLECTOR_TOKEN_SECRET, 'keep-me');
    const { fetchFn } = fakeHealth();
    const m = manager({ fetchFn });

    await m.reconfigure({ url: null, token: 'new-token' });
    expect(secrets.getSecret(COLLECTOR_TOKEN_SECRET)).toBe('new-token');
    expect(m.status().hasToken).toBe(true);

    await m.reconfigure({ url: null });
    expect(secrets.getSecret(COLLECTOR_TOKEN_SECRET)).toBe('new-token');

    await m.reconfigure({ url: null, token: null });
    expect(secrets.getSecret(COLLECTOR_TOKEN_SECRET)).toBeUndefined();
    expect(m.status().hasToken).toBe(false);
  });

  it('rejects a path URL and an env-locked reconfigure', async () => {
    const m = manager();
    await expect(m.reconfigure({ url: 'http://127.0.0.1:7777/api' })).rejects.toBeInstanceOf(CollectorUrlError);
    await expect(m.reconfigure({ url: 'ftp://127.0.0.1' })).rejects.toBeInstanceOf(CollectorUrlError);

    const locked = manager({ env: { LOUSHO_OBSERVE_URL: 'http://127.0.0.1:9999' } });
    await expect(locked.reconfigure({ url: null })).rejects.toBeInstanceOf(CollectorLockedError);
    expect(locked.status().lockedByEnv).toBe(true);
    expect(locked.url()).toBe('http://127.0.0.1:9999');
  });

  it('closes a Studio-started daemon when reconfigure moves to a different URL', async () => {
    const port = await freePort();
    const first = `http://127.0.0.1:${port}`;
    const remote = 'https://collector.example.com';
    const { fetchFn, calls } = fakeHealth();
    const urlFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      // Nothing answers on the first URL until our daemon binds; the remote
      // URL always answers like a daemon.
      if (String(input).startsWith(first)) {
        try {
          return await fetch(input, init);
        } catch {
          throw new Error('connection refused');
        }
      }
      return fetchFn(input, init);
    }) as typeof fetch;
    let started = 0;
    const m = manager({
      env: {},
      fetchFn: urlFetch,
      startDaemon: async (options) => {
        started += 1;
        const daemon = await startObserveDaemon({ ...options, dbPath: path.join(baseDir, `observe-${started}.db`) });
        daemons.push(daemon);
        return daemon;
      },
    });
    settings.setCollectorUrl(first);

    expect((await m.start()).mode).toBe('started');
    const daemon = daemons.at(-1)!;

    const status = await m.reconfigure({ url: remote });
    expect(status.mode).toBe('remote');
    expect(status.url).toBe(remote);
    expect(calls.at(-1)?.url).toBe(`${remote}/health`);
    // The moved-away daemon is closed: its port no longer answers.
    await expect(fetch(`${first}/health`)).rejects.toThrow();
    expect(daemon.port).toBe(port);
  });
});
