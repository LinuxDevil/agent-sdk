import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import { createApp } from '../app';
import { STUDIO_TOKEN_HEADER } from '../auth';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';

/**
 * Express 5 routes case-insensitively by default while the token gate used to
 * compare API prefixes case-sensitively, so `POST /PLAYGROUND/run` (and every
 * other case-changed API path) reached its handler with no token. The gate is
 * now deny-by-default: anything but a GET/HEAD of a non-API path (the static
 * client, `/health`) needs the token, whatever case, encoding or slashes the
 * path uses - and routing is case-sensitive, so a case-changed path 404s.
 */
describe('studio token gate (path variants)', () => {
  const TOKEN = 'gate-token-0123456789';
  let baseDir: string;
  let staticDir: string;
  let app: ReturnType<typeof createApp>;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gate-test-'));
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gate-static-'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>forge</title>');
    fs.writeFileSync(path.join(staticDir, 'app.js'), 'console.log(1)');
    const agentStore = createFsAgentStore(baseDir);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
    });
    app = createApp({ agentStore, runManager, baseDir, staticDir, access: { token: TOKEN } });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  /** Sends one raw HTTP/1.1 request line (absolute-form, odd paths supertest would normalise) and returns the status. */
  function rawStatus(method: string, target: string, headers: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        data += chunk;
        const match = /^HTTP\/1\.1 (\d{3})/.exec(data);
        if (match) {
          socket.destroy();
          resolve(Number(match[1]));
        }
      });
      socket.on('error', reject);
      const lines = [
        `${method} ${target} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: close',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      if (method === 'POST') lines.push('Content-Type: application/json', 'Content-Length: 2');
      socket.write(`${lines.join('\r\n')}\r\n\r\n${method === 'POST' ? '{}' : ''}`);
    });
  }

  it.each([
    ['POST', '/PLAYGROUND/run'],
    ['POST', '/Playground/run'],
    ['GET', '/Observe/api/v1/scores'],
    ['POST', '/Observe/api/v1/scores'],
    ['GET', '/SETTINGS/providers'],
    ['GET', '/Settings/profiles'],
    ['GET', '/AGENTS'],
    ['GET', '/Runs/compare?a=x&b=y'],
    ['GET', '/WORKSPACE'],
    // trailing and doubled slashes
    ['POST', '/playground/run/'],
    ['POST', '//playground/run'],
    ['POST', '//PLAYGROUND//run'],
    ['GET', '/agents/'],
    ['GET', '//agents'],
    ['GET', '/SETTINGS/providers/'],
    // percent-encoded prefix letters / separators
    ['POST', '/%70layground/run'],
    ['POST', '/%50LAYGROUND/run'],
    ['GET', '/observe%2Fapi/v1/scores'],
    ['GET', '/%61gents'],
    ['GET', '/%2561gents'],
    // HEAD / OPTIONS
    ['HEAD', '/AGENTS'],
    ['HEAD', '/agents'],
    ['OPTIONS', '/agents'],
    ['OPTIONS', '/PLAYGROUND/run'],
    // writes to non-API paths
    ['POST', '/'],
    ['POST', '/index.html'],
    ['PUT', '/health'],
    ['DELETE', '/app.js'],
  ])('%s %s without the token -> 401', async (method, target) => {
    expect(await rawStatus(method, target)).toBe(401);
  });

  it.each([
    ['POST', 'PLAYGROUND/run'],
    ['GET', 'Observe/api/v1/scores'],
    ['GET', 'SETTINGS/providers'],
    ['GET', 'AGENTS'],
    ['POST', '/playground/run'],
  ])('absolute-form %s http://host/%s without the token -> 401', async (method, rest) => {
    const target = `http://127.0.0.1:${port}/${rest.replace(/^\//, '')}`;
    expect(await rawStatus(method, target)).toBe(401);
  });

  it('the lowercase routes still work with the token (header or query)', async () => {
    const agents = await request(app).get('/agents').set(STUDIO_TOKEN_HEADER, TOKEN);
    expect(agents.status).toBe(200);
    expect(Array.isArray(agents.body)).toBe(true);
    expect((await request(app).get(`/settings/providers?token=${TOKEN}`)).status).toBe(200);
    expect((await request(app).get('/workspace').set(STUDIO_TOKEN_HEADER, TOKEN)).body).toEqual({ baseDir });
    // Reaches the playground handler (a validation error, not the gate).
    const run = await request(app).post('/playground/run').set(STUDIO_TOKEN_HEADER, TOKEN).send({});
    expect(run.status).toBe(400);
  });

  it('/health and the static client load without the token', async () => {
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.text).toBe('ok');
    expect((await request(app).head('/health')).status).toBe(200);
    const index = await request(app).get('/');
    expect(index.status).toBe(200);
    expect(index.text).toContain('<title>forge</title>');
    expect((await request(app).get('/app.js')).status).toBe(200);
    // SPA fallback for a client-side route.
    expect((await request(app).get('/some/client/view')).text).toContain('<title>forge</title>');
    expect(await rawStatus('GET', `http://127.0.0.1:${port}/`)).toBe(200);
  });

  it('a case-changed API path WITH the token is not routed to the handler (case-sensitive routing)', async () => {
    const run = await request(app).post('/PLAYGROUND/run').set(STUDIO_TOKEN_HEADER, TOKEN).send({});
    expect(run.status).toBe(404);
    const settings = await request(app).delete('/SETTINGS/providers/openai').set(STUDIO_TOKEN_HEADER, TOKEN);
    expect(settings.status).toBe(404);
    // A case-changed GET falls through to the SPA fallback (static html), never the JSON handler.
    const agents = await request(app).get('/AGENTS').set(STUDIO_TOKEN_HEADER, TOKEN);
    expect(agents.headers['content-type']).toMatch(/text\/html/);
  });
});
