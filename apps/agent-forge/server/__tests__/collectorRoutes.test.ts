/**
 * `GET/PUT /settings/collector` (routes/collectorRoutes.ts over
 * collector.ts): the status is sanitized (never the token), `?probe=1`
 * forces a fresh probe, and PUT validates the URL, honours the
 * `LOUSHO_OBSERVE_URL` lock and applies the token semantics.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CollectorManager, COLLECTOR_TOKEN_SECRET, DEFAULT_COLLECTOR_URL, type CollectorDeps } from '../collector';
import { registerCollectorRoutes } from '../routes/collectorRoutes';
import { SettingsStore } from '../settingsStore';
import { SecretsStore } from '../secretsStore';
import type { CollectorStatus } from '../../shared/wireTypes';

const HEALTH = { service: 'lousho-observe', ok: true, version: '1.0.0-test' };

function fakeFetch(calls: { url: string; headers: Headers }[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(HEALTH), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('/settings/collector', () => {
  let baseDir: string;
  let settings: SettingsStore;
  let secrets: SecretsStore;
  let calls: { url: string; headers: Headers }[];
  let app: express.Express;
  let env: NodeJS.ProcessEnv;

  function build(over: Partial<CollectorDeps> = {}): CollectorManager {
    const manager = new CollectorManager({ settings, secrets, env, fetchFn: fakeFetch(calls), autoStart: false, ...over });
    app = express();
    app.use(express.json());
    registerCollectorRoutes(app, manager);
    return manager;
  }

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-collector-routes-'));
    settings = new SettingsStore(baseDir);
    secrets = new SecretsStore(baseDir);
    calls = [];
    env = {};
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('GET returns the sanitized status (hasToken, never the token)', async () => {
    secrets.setSecret(COLLECTOR_TOKEN_SECRET, 's3cret');
    build();
    const res = await request(app).get('/settings/collector');
    expect(res.status).toBe(200);
    const status = res.body as CollectorStatus;
    expect(status.mode).toBe('down'); // autoStart off, nothing probed yet
    expect(status.url).toBe(DEFAULT_COLLECTOR_URL);
    expect(status.hasToken).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('s3cret');
  });

  it('GET ?probe=1 probes the URL and reports remote with the token as bearer', async () => {
    secrets.setSecret(COLLECTOR_TOKEN_SECRET, 's3cret');
    env = { LOUSHO_OBSERVE_URL: 'https://collector.example.com' };
    build();
    const res = await request(app).get('/settings/collector?probe=1');
    expect(res.status).toBe(200);
    expect((res.body as CollectorStatus).mode).toBe('remote');
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get('authorization')).toBe('Bearer s3cret');
  });

  it('PUT rejects a path URL, a non-http scheme and a malformed body with 400', async () => {
    build();
    for (const url of ['http://127.0.0.1:7777/api', 'ftp://127.0.0.1', 'not a url']) {
      const res = await request(app).put('/settings/collector').send({ url });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LOUSHO_COLLECTOR_URL_INVALID');
    }
    expect((await request(app).put('/settings/collector').send({ url: 42 })).status).toBe(400);
    expect((await request(app).put('/settings/collector').send({})).status).toBe(400);
    expect(settings.getCollectorUrl()).toBeNull();
  });

  it('PUT with LOUSHO_OBSERVE_URL set answers 409 and changes nothing', async () => {
    env = { LOUSHO_OBSERVE_URL: 'http://127.0.0.1:9999' };
    build();
    const res = await request(app).put('/settings/collector').send({ url: 'https://collector.example.com' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOUSHO_COLLECTOR_ENV_LOCKED');
    expect(settings.getCollectorUrl()).toBeNull();
  });

  it('PUT persists the URL, applies token semantics and answers the new status', async () => {
    build();
    const url = 'https://collector.example.com';
    const res = await request(app)
      .put('/settings/collector')
      .send({ url, token: 's3cret' });
    expect(res.status).toBe(200);
    const status = res.body as CollectorStatus;
    expect(status.mode).toBe('remote');
    expect(status.url).toBe(url);
    expect(status.hasToken).toBe(true);
    expect(settings.getCollectorUrl()).toBe(url);
    expect(secrets.getSecret(COLLECTOR_TOKEN_SECRET)).toBe('s3cret');
    expect(JSON.stringify(res.body)).not.toContain('s3cret');

    // token undefined keeps the secret; token null removes it.
    await request(app).put('/settings/collector').send({ url });
    expect(secrets.getSecret(COLLECTOR_TOKEN_SECRET)).toBe('s3cret');
    const cleared = await request(app).put('/settings/collector').send({ url, token: null });
    expect(cleared.status).toBe(200);
    expect((cleared.body as CollectorStatus).hasToken).toBe(false);
    expect(secrets.getSecret(COLLECTOR_TOKEN_SECRET)).toBeUndefined();
  });
});
