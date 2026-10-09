import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { startStudioServer, type StudioServerHandle } from '../index';
import { allowedHostsFor, STUDIO_TOKEN_HEADER } from '../auth';

/**
 * Eve DUI-F1: the studio API used to answer any origin
 * (`Access-Control-Allow-Origin: *`) with no auth, while it stores provider
 * keys, starts runs and executes hook code.
 */
describe('studio access control (Eve DUI-F1)', () => {
  const TOKEN = 'test-token-0123456789';
  let baseDir: string;
  let staticDir: string;
  let handle: StudioServerHandle;
  let origin: string;

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-auth-test-'));
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-auth-static-'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>forge</title>');
    handle = await startStudioServer({ baseDir, port: 0, staticDir, token: TOKEN });
    origin = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    await handle.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  it('prints a URL carrying the token', () => {
    expect(handle.token).toBe(TOKEN);
    expect(handle.url).toBe(`${origin}/?token=${TOKEN}`);
  });

  it('sends no wildcard CORS header and refuses a foreign Origin', async () => {
    const res = await fetch(`${origin}/agents`, {
      headers: { Origin: 'https://example.com', [STUDIO_TOKEN_HEADER]: TOKEN },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const health = await fetch(`${origin}/health`, { headers: { Origin: 'https://example.com' } });
    expect(health.status).toBe(403);
    expect(health.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses a cross-origin provider-key write even with a valid-looking body', async () => {
    const res = await fetch(`${origin}/settings/providers/openai`, {
      method: 'PUT',
      headers: { Origin: 'http://localhost:9999', 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-attacker' }),
    });
    expect(res.status).toBe(403);
  });

  it('requires the token on API routes', async () => {
    expect((await fetch(`${origin}/agents`)).status).toBe(401);
    expect((await fetch(`${origin}/settings/providers`)).status).toBe(401);
    expect((await fetch(`${origin}/agents`, { headers: { [STUDIO_TOKEN_HEADER]: 'wrong' } })).status).toBe(401);
    expect((await fetch(`${origin}/agents`, { headers: { [STUDIO_TOKEN_HEADER]: TOKEN } })).status).toBe(200);
    expect((await fetch(`${origin}/agents?token=${TOKEN}`)).status).toBe(200);
  });

  it('accepts a same-origin request with the token', async () => {
    const res = await fetch(`${origin}/agents`, { headers: { Origin: origin, [STUDIO_TOKEN_HEADER]: TOKEN } });
    expect(res.status).toBe(200);
  });

  it('serves the static client and /health without the token', async () => {
    expect((await fetch(`${origin}/`)).status).toBe(200);
    expect((await fetch(`${origin}/health`)).status).toBe(200);
  });

  it('refuses a non-loopback Host header (DNS rebinding)', async () => {
    const http = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: handle.port, path: `/agents?token=${TOKEN}`, headers: { Host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  function openWs(url: string, headers: Record<string, string> = {}): Promise<'open' | number> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url, { headers });
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
  }

  it('requires the token and a same/no Origin on the WebSocket', async () => {
    const wsBase = `ws://127.0.0.1:${handle.port}/agents/a1/stream`;
    expect(await openWs(wsBase)).toBe(401);
    expect(await openWs(`${wsBase}?token=${TOKEN}`, { Origin: 'https://example.com' })).toBe(403);
    expect(await openWs(`${wsBase}?token=${TOKEN}`)).toBe('open');
    expect(await openWs(`${wsBase}?token=${TOKEN}`, { Origin: origin })).toBe('open');
  });
});

describe('allowedHostsFor', () => {
  it('accepts only loopback for a loopback bind, the host itself for a named bind, any host for a wildcard', () => {
    expect(allowedHostsFor('127.0.0.1')).toEqual([]);
    expect(allowedHostsFor('192.168.1.5')).toEqual(['192.168.1.5']);
    expect(allowedHostsFor('0.0.0.0')).toEqual(['*']);
  });
});
