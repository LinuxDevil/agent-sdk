/**
 * `/observe/**` -> the observe daemon: the studio server forwards the
 * panels' GETs same-origin, because the daemon itself serves no CORS
 * headers. A dead daemon answers 502 with the `lousho observe start` hint.
 * Writes go through only when OBSERVE_WRITE_ALLOWLIST names the method and
 * path (feedback scores, a prompt label move, a hub publish); every other non-GET stays 405.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { once } from 'node:events';
import request from 'supertest';
import { createApp } from '../app';
import { OBSERVE_WRITE_ALLOWLIST } from '../observeProxy';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';

describe('observe proxy', () => {
  let baseDir: string;
  let app: ReturnType<typeof createApp>;
  let daemon: http.Server | undefined;
  let daemonUrl: string;
  const prevEnv = process.env.LOUSHO_OBSERVE_URL;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-observe-proxy-test-'));
    const agentStore = createFsAgentStore(baseDir);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
    });
    app = createApp({ agentStore, runManager, baseDir });

    // A stand-in for `lousho observe`: echoes the method, path, content-type and body it was sent.
    daemon = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            echoed: req.url,
            method: req.method,
            contentType: req.headers['content-type'] ?? null,
            body: body ? JSON.parse(body) : null,
          }),
        );
      });
    });
    daemon.listen(0, '127.0.0.1');
    await once(daemon, 'listening');
    daemonUrl = `http://127.0.0.1:${(daemon.address() as { port: number }).port}`;
    process.env.LOUSHO_OBSERVE_URL = daemonUrl;
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.LOUSHO_OBSERVE_URL;
    else process.env.LOUSHO_OBSERVE_URL = prevEnv;
    daemon?.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('forwards GETs under /observe to the daemon, prefix stripped', async () => {
    const res = await request(app).get('/observe/api/v1/traces?status=error&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.echoed).toBe('/api/v1/traces?status=error&limit=10');
  });

  it('answers GET /observe/__target with the daemon url the proxy points at', async () => {
    const res = await request(app).get('/observe/__target');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: daemonUrl });
  });

  it('answers 502 with the start hint when the daemon is down', async () => {
    daemon?.close();
    daemon = undefined;
    const res = await request(app).get('/observe/api/v1/agents');
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('lousho observe start');
  });

  it('forwards POST /api/v1/scores with its JSON body (the write allowlist)', async () => {
    const score = { trace_id: 't1', obs_id: 'o1', name: 'feedback', value: 1, comment: 'good' };
    const res = await request(app).post('/observe/api/v1/scores').send(score);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ echoed: '/api/v1/scores', method: 'POST', contentType: 'application/json', body: score });
  });

  it('does not forward other writes - ingest and unlisted routes stay 405', async () => {
    expect((await request(app).post('/observe/api/v1/ingest').send({ batch: [] })).status).toBe(405);
    expect((await request(app).post('/observe/api/v1/traces').send({})).status).toBe(405);
    expect((await request(app).put('/observe/api/v1/scores').send({})).status).toBe(405);
    expect((await request(app).delete('/observe/api/v1/scores')).status).toBe(405);
  });

  it('forwards POST /api/v1/hub (a Context Hub fleet entry edit) with its JSON body', async () => {
    const entry = { agent_id: 'a1', namespace: 'docs', key: 'k', value: { a: 1 }, scope: 'fleet' };
    const res = await request(app).post('/observe/api/v1/hub').send(entry);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ echoed: '/api/v1/hub', method: 'POST', contentType: 'application/json', body: entry });
  });

  it('forwards an allowlisted PUT (prompt label move) with its JSON body and content-type', async () => {
    const res = await request(app).put('/observe/api/v1/prompts/mira/labels/prod').send({ version: 2 });
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('PUT');
    expect(res.body.echoed).toBe('/api/v1/prompts/mira/labels/prod');
    expect(res.body.contentType).toContain('application/json');
    expect(res.body.body).toEqual({ version: 2 });
  });

  it.each([
    ['post', '/observe/api/v1/prompts'],
    ['put', '/observe/api/v1/prompts/mira'],
    ['put', '/observe/api/v1/prompts/mira/labels/prod/extra'],
    ['delete', '/observe/api/v1/prompts/mira/labels/prod'],
    ['post', '/observe/api/v1/prompts/mira/labels/prod'],
    ['post', '/observe/api/v1/hub/x'],
    ['put', '/observe/api/v1/hub'],
    ['post', '/observe/v1/traces'],
  ] as const)('keeps %s %s at 405', async (method, url) => {
    const res = await request(app)[method](url).send({ version: 1 });
    expect(res.status).toBe(405);
  });

  it.each([
    '/observe/api/v1/prompts/%2e%2e/labels/x',
    '/observe/api/v1/prompts/%2E/labels/x',
    '/observe/api/v1/prompts/mira/labels/%2e%2E',
    '/observe/api/v1/prompts/a%2Fb/labels/x',
    '/observe/api/v1/prompts/a%5cb/labels/x',
    '/observe/api/v1/prompts/%E0%A4%A/labels/x',
  ])('keeps an allowlisted shape with a dot, encoded-slash or undecodable segment at 405: %s', async (url) => {
    const res = await request(app).put(url).send({ version: 1 });
    expect(res.status).toBe(405);
  });

  it('rejects an allowlisted write whose body is over 1 MiB with 413', async () => {
    const res = await request(app)
      .put('/observe/api/v1/prompts/mira/labels/prod')
      .send({ version: 1, pad: 'x'.repeat(1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it('exports one write allowlist of method + path pairs: feedback scores, the label move and hub publishes', () => {
    expect(OBSERVE_WRITE_ALLOWLIST.map((entry) => entry.method)).toEqual(['POST', 'PUT', 'POST']);
    expect(OBSERVE_WRITE_ALLOWLIST.every((entry) => entry.path instanceof RegExp)).toBe(true);
  });
});
