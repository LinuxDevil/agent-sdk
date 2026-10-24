/**
 * `/observe/**` -> the observe daemon: the studio server forwards the
 * panels' GETs same-origin, because the daemon itself serves no CORS
 * headers. A dead daemon answers 502 with the `lousho observe start` hint;
 * writes are forwarded only for the allowlist (feedback scores), every other
 * non-GET stays reporter-only (405).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { once } from 'node:events';
import request from 'supertest';
import { createApp } from '../app';
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

    // A stand-in for `lousho observe`: echoes the path it was asked for.
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
});
