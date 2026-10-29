/**
 * `/observe/**` -> the observe daemon: the studio server forwards the
 * panels' GETs same-origin, because the daemon itself serves no CORS
 * headers. A dead daemon answers 502 with the `lousho observe start` hint.
 * Writes go through only when OBSERVE_WRITE_ALLOWLIST names the method and
 * path (feedback scores, a prompt label move, a hub publish, dataset and
 * example writes, annotation queue writes, evaluator rule writes); every
 * other non-GET stays 405.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { once } from 'node:events';
import request from 'supertest';
import { createApp } from '../app';
import { OBSERVE_WRITE_ALLOWLIST, observeUpstreamUrl } from '../observeProxy';
import { STUDIO_TOKEN_HEADER } from '../auth';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';

describe('observe proxy', () => {
  let baseDir: string;
  let app: ReturnType<typeof createApp>;
  let daemon: http.Server | undefined;
  let daemonUrl: string;
  let lastDelete: { url: string | undefined; contentType: string | null; body: string } | undefined;
  let lastHeaders: http.IncomingHttpHeaders | undefined;
  const prevEnv = process.env.LOUSHO_OBSERVE_URL;
  const prevToken = process.env.LOUSHO_OBSERVE_TOKEN;

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
      lastHeaders = req.headers;
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        // A code rule, so judge.ts's test route (registered before the proxy) forwards its /test here.
        if (req.method === 'GET' && req.url === '/api/v1/evaluators/r1') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ evaluator: { rule_id: 'r1', kind: 'code' } }));
          return;
        }
        if (req.method === 'DELETE') {
          lastDelete = { url: req.url, contentType: req.headers['content-type'] ?? null, body };
          res.writeHead(204);
          res.end();
          return;
        }
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
    if (prevToken === undefined) delete process.env.LOUSHO_OBSERVE_TOKEN;
    else process.env.LOUSHO_OBSERVE_TOKEN = prevToken;
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

  it("does not forward the browser's Origin, Sec-Fetch-* or Referer upstream (the daemon refuses cross-origin writes)", async () => {
    const res = await request(app)
      .post('/observe/api/v1/evaluators')
      .set('Host', 'localhost:5173')
      .set('Origin', 'http://localhost:5173')
      .set('Referer', 'http://localhost:5173/evaluators')
      .set('Sec-Fetch-Site', 'same-origin')
      .set('Sec-Fetch-Mode', 'cors')
      .send({ name: 'r', kind: 'code' });
    expect(res.status).toBe(201);
    expect(lastHeaders?.['content-type']).toBe('application/json');
    for (const header of ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-dest']) expect(lastHeaders?.[header]).toBeUndefined();
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

  it('forwards POST /api/v1/datasets (a new dataset) with its JSON body', async () => {
    const res = await request(app).post('/observe/api/v1/datasets').send({ name: 'golden', description: 'd' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      echoed: '/api/v1/datasets',
      method: 'POST',
      contentType: 'application/json',
      body: { name: 'golden', description: 'd' },
    });
  });

  it('forwards POST /api/v1/datasets/:name/examples (add from a trace) with its JSON body', async () => {
    const res = await request(app).post('/observe/api/v1/datasets/golden/examples').send({ from_trace_id: 't1' });
    expect(res.status).toBe(201);
    expect(res.body.echoed).toBe('/api/v1/datasets/golden/examples');
    expect(res.body.body).toEqual({ from_trace_id: 't1' });
  });

  it('forwards DELETE /api/v1/datasets/:name/examples/:id with no body and passes the 204 back', async () => {
    lastDelete = undefined;
    const res = await request(app).delete('/observe/api/v1/datasets/golden/examples/e1');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(lastDelete).toEqual({ url: '/api/v1/datasets/golden/examples/e1', contentType: null, body: '' });
  });

  it.each([
    ['delete', '/observe/api/v1/datasets/golden'],
    ['delete', '/observe/api/v1/datasets/golden/examples'],
    ['put', '/observe/api/v1/datasets/golden/examples/e1'],
    ['post', '/observe/api/v1/datasets/golden/examples/e1'],
    ['post', '/observe/api/v1/datasets/golden'],
    ['delete', '/observe/api/v1/traces/t1'],
  ] as const)('keeps the dataset-adjacent write %s %s at 405', async (method, url) => {
    const res = await request(app)[method](url).send({});
    expect(res.status).toBe(405);
  });

  it('keeps a DELETE whose example segment is a dot or an encoded slash at 405', async () => {
    expect((await request(app).delete('/observe/api/v1/datasets/golden/examples/%2e%2e')).status).toBe(405);
    expect((await request(app).delete('/observe/api/v1/datasets/a%2Fb/examples/e1')).status).toBe(405);
  });

  it.each([
    ['/api/v1/queues', { name: 'review', rubric: [{ name: 'helpful', min: 0, max: 5 }] }],
    ['/api/v1/queues/q1/items', { trace_ids: ['t1'] }],
    ['/api/v1/queues/q1/items/i1/complete', { scores: [{ name: 'helpful', value: 4 }] }],
  ] as const)('forwards the annotation queue write POST %s with its JSON body', async (path, body) => {
    const res = await request(app).post(`/observe${path}`).send(body);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ echoed: path, method: 'POST', contentType: 'application/json', body });
  });

  it.each([
    ['delete', '/observe/api/v1/queues/q1'],
    ['post', '/observe/api/v1/queues/q1'],
    ['put', '/observe/api/v1/queues/q1/items'],
    ['post', '/observe/api/v1/queues/q1/next'],
    ['post', '/observe/api/v1/queues/q1/items/i1'],
    ['post', '/observe/api/v1/queues/q1/items/i1/complete/x'],
    ['post', '/observe/api/v1/queues/q1/items/%2e%2e/complete'],
  ] as const)('keeps the queue-adjacent write %s %s at 405', async (method, url) => {
    const res = await request(app)[method](url).send({});
    expect(res.status).toBe(405);
  });

  it('forwards POST /api/v1/evaluators with its JSON body', async () => {
    const body = { name: 'answered', kind: 'code', config: { source: '(trace) => 1' } };
    const res = await request(app).post('/observe/api/v1/evaluators').send(body);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ echoed: '/api/v1/evaluators', method: 'POST', contentType: 'application/json', body });
  });

  it('forwards PUT /api/v1/evaluators/:id with its partial JSON body', async () => {
    const res = await request(app).put('/observe/api/v1/evaluators/r1').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ echoed: '/api/v1/evaluators/r1', method: 'PUT', contentType: 'application/json', body: { enabled: false } });
  });

  it('forwards DELETE /api/v1/evaluators/:id with no body and passes the 204 back', async () => {
    lastDelete = undefined;
    const res = await request(app).delete('/observe/api/v1/evaluators/r1');
    expect(res.status).toBe(204);
    expect(lastDelete).toEqual({ url: '/api/v1/evaluators/r1', contentType: null, body: '' });
  });

  it('leaves POST /api/v1/evaluators/:id/test to the Studio route, which forwards a code rule to the daemon', async () => {
    const res = await request(app).post('/observe/api/v1/evaluators/r1/test').send({ trace_id: 't1' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ echoed: '/api/v1/evaluators/r1/test', method: 'POST', body: { trace_id: 't1' } });
  });

  it.each([
    ['delete', '/observe/api/v1/evaluators'],
    ['put', '/observe/api/v1/evaluators'],
    ['post', '/observe/api/v1/evaluators/r1'],
    ['put', '/observe/api/v1/evaluators/r1/test'],
    ['post', '/observe/api/v1/evaluators/judge-jobs/claim'],
    ['post', '/observe/api/v1/evaluators/judge-jobs/j1/result'],
    ['put', '/observe/api/v1/evaluators/%2e%2e'],
    ['delete', '/observe/api/v1/evaluators/a%2Fb'],
  ] as const)('keeps the evaluator-adjacent write %s %s at 405', async (method, url) => {
    const res = await request(app)[method](url).send({});
    expect(res.status).toBe(405);
  });

  it('forwards POST /api/v1/prompts (the playground "Save as new prompt version") with its JSON body', async () => {
    const version = { name: 'support-greeter', text: 'Hi {user}', variables: ['user'] };
    const res = await request(app).post('/observe/api/v1/prompts').send(version);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ echoed: '/api/v1/prompts', method: 'POST', contentType: 'application/json', body: version });
  });

  it.each([
    ['post', '/observe/api/v1/prompts/'],
    ['post', '/observe/api/v1/prompts/mira'],
    ['post', '/observe/api/v1/prompts/x'],
    ['post', '/observe/API/v1/prompts'],
    ['post', '/observe/api/v1/Prompts'],
    ['post', '/observe/api/v1/scores/'],
    ['put', '/observe/api/v1/prompts'],
    ['delete', '/observe/api/v1/prompts'],
    ['patch', '/observe/api/v1/prompts'],
    ['patch', '/observe/api/v1/scores'],
    ['options', '/observe/api/v1/scores'],
    ['head', '/observe/api/v1/scores'],
    ['put', '/observe/api/v1/prompts/mira'],
    ['put', '/observe/api/v1/prompts/mira/labels/prod/extra'],
    ['delete', '/observe/api/v1/prompts/mira/labels/prod'],
    ['post', '/observe/api/v1/prompts/mira/labels/prod'],
    ['post', '/observe/api/v1/hub/x'],
    ['put', '/observe/api/v1/hub'],
    ['post', '/observe/v1/traces'],
  ] as const)('keeps %s %s at 405', async (method, url) => {
    const pending = request(app)[method](url);
    const res = method === 'head' ? await pending : await pending.send({ version: 1 });
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

  it('exports one write allowlist of method + path pairs: feedback scores, the label move, a new prompt version, hub publishes, dataset, queue and evaluator writes', () => {
    expect(OBSERVE_WRITE_ALLOWLIST.map((entry) => entry.method)).toEqual([
      'POST', 'POST', 'PUT', 'POST', 'POST', 'POST', 'DELETE', 'POST', 'POST', 'POST', 'POST', 'PUT', 'DELETE',
    ]);
    expect(OBSERVE_WRITE_ALLOWLIST.every((entry) => entry.path instanceof RegExp)).toBe(true);
  });
});

/**
 * The proxy behind the real token gate, over real sockets: the upstream is
 * built from the routed path and query only (never the request line's
 * authority), always lands on the observe target's origin, carries
 * `LOUSHO_OBSERVE_TOKEN` as the daemon bearer when set, and never forwards
 * the client's own credentials.
 */
describe('observe proxy (upstream origin and credentials)', () => {
  const TOKEN = 'proxy-studio-token-0123456789';
  let baseDir: string;
  let studio: http.Server;
  let studioPort: number;
  let daemon: http.Server;
  let daemonUrl: string;
  let evil: http.Server;
  let evilPort: number;
  let daemonSeen: { method: string | undefined; url: string | undefined; headers: http.IncomingHttpHeaders; body: string }[];
  let evilSeen: string[];
  const prevEnv = process.env.LOUSHO_OBSERVE_URL;
  const prevToken = process.env.LOUSHO_OBSERVE_TOKEN;

  async function listen(server: http.Server): Promise<number> {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return (server.address() as net.AddressInfo).port;
  }

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-observe-proxy-origin-'));
    const agentStore = createFsAgentStore(baseDir);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
    });
    daemonSeen = [];
    evilSeen = [];
    daemon = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        daemonSeen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ daemon: true, url: req.url }));
      });
    });
    evil = http.createServer((req, res) => {
      evilSeen.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ evil: true }));
    });
    daemonUrl = `http://127.0.0.1:${await listen(daemon)}`;
    evilPort = await listen(evil);
    process.env.LOUSHO_OBSERVE_URL = daemonUrl;
    delete process.env.LOUSHO_OBSERVE_TOKEN;
    studio = http.createServer(createApp({ agentStore, runManager, baseDir, access: { token: TOKEN } }));
    studioPort = await listen(studio);
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.LOUSHO_OBSERVE_URL;
    else process.env.LOUSHO_OBSERVE_URL = prevEnv;
    if (prevToken === undefined) delete process.env.LOUSHO_OBSERVE_TOKEN;
    else process.env.LOUSHO_OBSERVE_TOKEN = prevToken;
    for (const server of [studio, daemon, evil]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  /** One raw HTTP/1.1 request (any request-target form) with the studio token and a loopback Host; the status and body. */
  function raw(method: string, target: string, headers: Record<string, string> = {}, body = ''): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(studioPort, '127.0.0.1');
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => (data += chunk));
      socket.on('end', () => {
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1]);
        resolve({ status, body: data.slice(data.indexOf('\r\n\r\n') + 4) });
      });
      socket.on('error', reject);
      const lines = [
        `${method} ${target} HTTP/1.1`,
        `Host: 127.0.0.1:${studioPort}`,
        `${STUDIO_TOKEN_HEADER}: ${TOKEN}`,
        'Connection: close',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`);
    });
  }

  it.each([
    () => `http://a@127.0.0.1:${evilPort}/observe/api/v1/traces?limit=1`,
    () => `http://127.0.0.1:${evilPort}/observe/api/v1/traces?limit=1`,
    () => `http://evil.example/observe/api/v1/traces?limit=1`,
    () => `http://a@evil.example/observe/api/v1/traces?limit=1`,
    () => `http://user:pw@127.0.0.1:${evilPort}/observe/api/v1/traces?limit=1`,
  ])('an absolute-form request line only ever reaches the observe target (#%#)', async (target) => {
    const res = await raw('GET', target());
    expect(evilSeen).toEqual([]);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ daemon: true, url: '/api/v1/traces?limit=1' });
    expect(daemonSeen.map((seen) => seen.url)).toEqual(['/api/v1/traces?limit=1']);
  });

  it('fetches only URLs on the observe target origin for an absolute-form line with userinfo', async () => {
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      fetched.push(String(input));
      return realFetch(input, init);
    });
    try {
      await raw('GET', 'http://a@evil.example/observe/api/v1/traces');
      await raw('GET', `http://a@127.0.0.1:${evilPort}/observe/api/v1/traces`);
    } finally {
      spy.mockRestore();
    }
    expect(fetched.map((url) => new URL(url).origin)).toEqual([daemonUrl, daemonUrl]);
    expect(fetched.map((url) => new URL(url).username)).toEqual(['', '']);
  });

  it.each([
    () => `/observe//127.0.0.1:${evilPort}/api/v1/traces`,
    () => `/observe/%2F%2F127.0.0.1:${evilPort}/api/v1/traces`,
    () => `/observe/@127.0.0.1:${evilPort}/api/v1/traces`,
    () => `/observe/api/v1/traces?next=http://127.0.0.1:${evilPort}/x&a=@127.0.0.1:${evilPort}`,
    () => `/observe?@127.0.0.1:${evilPort}/`,
  ])('a path or query naming another host stays on the observe target (#%#)', async (target) => {
    await raw('GET', target());
    expect(evilSeen).toEqual([]);
    expect(daemonSeen).toHaveLength(1);
  });

  it.each([
    ['DELETE', '/observe/api/v1/datasets/x/examples/a\\..\\..\\..\\..\\..\\..\\api\\v1\\prompts\\mira'],
    ['PUT', '/observe/api/v1/evaluators/a\\..\\..\\..\\..\\api\\v1\\prompts\\mira'],
    ['PUT', '/observe/api/v1/evaluators/a\\..\\..\\..\\..\\v1\\traces'],
    ['POST', '/observe/api/v1/datasets/a\\..\\..\\..\\v1/examples'],
    ['PUT', '/observe/api/v1/evaluators/a\\b'],
    ['PUT', '/observe/api/v1/prompts/mi\\ra/labels/prod'],
  ])('a literal backslash in an allowlisted write segment is refused before any fetch: %s %s', async (method, target) => {
    const res = await raw(method, target, { 'Content-Type': 'application/json', 'Content-Length': '2' }, '{}');
    expect(res.status).toBe(405);
    expect(daemonSeen).toEqual([]);
  });

  it('a backslash dot-segment write against a base-path target with the daemon token set never reaches the daemon', async () => {
    process.env.LOUSHO_OBSERVE_URL = `${daemonUrl}/base`;
    process.env.LOUSHO_OBSERVE_TOKEN = 'daemon-token-abc';
    const res = await raw('DELETE', '/observe/api/v1/datasets/x/examples/a\\..\\..\\..\\..\\..\\..\\api\\v1\\prompts\\mira');
    expect(res.status).toBe(405);
    expect(daemonSeen).toEqual([]);
  });

  it.each([
    '/observe/api/v1/traces/a\\..\\..\\prompts',
    '/observe/\\\\127.0.0.1:1/api/v1/traces',
    '/observe/api/v1/..',
    '/observe/api/v1/%2e%2e/x',
    '/observe/api/./v1/traces',
  ])('a read whose path URL normalisation would rewrite answers 400 without a fetch: %s', async (target) => {
    const res = await raw('GET', target);
    expect(res.status).toBe(400);
    expect(daemonSeen).toEqual([]);
  });

  it('the query is taken from before a fragment, never from inside it', async () => {
    await raw('GET', `/observe/api/v1/traces#?@127.0.0.1:${evilPort}`);
    expect(evilSeen).toEqual([]);
    expect(daemonSeen.map((seen) => seen.url)).not.toContain(`/api/v1/traces?@127.0.0.1:${evilPort}`);
    for (const seen of daemonSeen) expect(seen.url).not.toContain('?');
  });

  it('sends no bearer to the daemon when LOUSHO_OBSERVE_TOKEN is unset, and never the client credentials', async () => {
    await raw('GET', '/observe/api/v1/traces', { Authorization: `Bearer ${TOKEN}`, Cookie: `lousho_studio_token=${TOKEN}` });
    expect(daemonSeen).toHaveLength(1);
    const { headers } = daemonSeen[0];
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers[STUDIO_TOKEN_HEADER]).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain(TOKEN);
  });

  it('forwards LOUSHO_OBSERVE_TOKEN as the daemon bearer on reads and writes, never the Studio token', async () => {
    process.env.LOUSHO_OBSERVE_TOKEN = 'daemon-token-abc';
    await raw('GET', '/observe/api/v1/traces', { Authorization: `Bearer ${TOKEN}` });
    const score = { trace_id: 't1', name: 'feedback', value: 1 };
    const write = await request(studio)
      .post('/observe/api/v1/scores')
      .set(STUDIO_TOKEN_HEADER, TOKEN)
      .set('Host', `127.0.0.1:${studioPort}`)
      .send(score);
    expect(write.status).toBe(201);
    expect(daemonSeen.map((seen) => seen.headers.authorization)).toEqual(['Bearer daemon-token-abc', 'Bearer daemon-token-abc']);
    for (const seen of daemonSeen) {
      expect(seen.headers[STUDIO_TOKEN_HEADER]).toBeUndefined();
      expect(JSON.stringify(seen.headers)).not.toContain(TOKEN);
    }
  });

  it('the playground "Save as new prompt version" POST reaches the daemon with its JSON body (token-gated server)', async () => {
    // SavePrompt.tsx -> observeClient.createPrompt({ name, text, variables }).
    const version = { name: 'support-greeter', text: 'You greet {user}.', variables: ['user'] };
    const unauthenticated = await request(studio).post('/observe/api/v1/prompts').set('Host', `127.0.0.1:${studioPort}`).send(version);
    expect(unauthenticated.status).toBe(401);
    expect(daemonSeen).toEqual([]);
    const res = await request(studio)
      .post('/observe/api/v1/prompts')
      .set(STUDIO_TOKEN_HEADER, TOKEN)
      .set('Host', `127.0.0.1:${studioPort}`)
      .send(version);
    expect(res.status).toBe(201);
    expect(daemonSeen).toHaveLength(1);
    expect(daemonSeen[0]).toMatchObject({ method: 'POST', url: '/api/v1/prompts' });
    expect(daemonSeen[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(daemonSeen[0].body)).toEqual(version);
  });
});

describe('observeUpstreamUrl', () => {
  const prevEnv = process.env.LOUSHO_OBSERVE_URL;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.LOUSHO_OBSERVE_URL;
    else process.env.LOUSHO_OBSERVE_URL = prevEnv;
  });

  it('appends the routed path and query to the target, keeping its base path', () => {
    process.env.LOUSHO_OBSERVE_URL = 'https://collector.test/base/';
    expect(observeUpstreamUrl('/api/v1/traces', '?limit=1')?.href).toBe('https://collector.test/base/api/v1/traces?limit=1');
    expect(observeUpstreamUrl('//evil.example/x', '')?.href).toBe('https://collector.test/base//evil.example/x');
  });

  it.each(['@evil.example/api', ':1@evil.example/api', '.evil.example/api', '/../../x', '/api/%2e%2e/%2e%2e/x', '/api\\..\\x','/api/./x', '/api/..'])(
    'refuses a path that would leave the target origin or that URL parsing would rewrite: %s',
    (routed) => {
      process.env.LOUSHO_OBSERVE_URL = 'http://127.0.0.1:7777/base';
      expect(observeUpstreamUrl(routed, '')).toBeUndefined();
    },
  );
});
