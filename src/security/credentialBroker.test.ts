import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo, Socket } from 'node:net';
import { createCredentialBroker, CredentialBroker, CredentialBrokerOptions } from './credentialBroker';
import { NodeWorkspace } from '../tools/workspace/NodeWorkspace';

/** A fake token planted for these tests only. */
const SECRET = 'fake-broker-secret-x12';
const LOOPBACK = '127.0.0.1';

let upstream: http.Server;
let upstreamHost: string;
const seen: http.IncomingHttpHeaders[] = [];
const brokers: CredentialBroker[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    res.setHeader('connection', 'x-upstream-hop');
    res.setHeader('x-upstream-hop', 'drop-me');
    res.end(JSON.stringify({ path: req.url, authorization: req.headers.authorization ?? null }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, LOOPBACK, resolve));
  upstreamHost = `${LOOPBACK}:${(upstream.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

afterEach(async () => {
  seen.length = 0;
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});

/** A broker whose loopback test upstream is explicitly allowed to be private. */
async function broker(options: Partial<CredentialBrokerOptions> = {}): Promise<CredentialBroker> {
  const created = await createCredentialBroker({
    rules: { [LOOPBACK]: { authorization: () => `Bearer ${SECRET}`, 'x-static': 'static-value' } },
    allowPrivate: [LOOPBACK],
    pathFormScheme: 'http',
    ...options,
  });
  brokers.push(created);
  return created;
}

function proxyPort(b: CredentialBroker): number {
  return Number(new URL(b.url).port);
}

/** Sends `path` (absolute-URI or `/__broker/` form) to the proxy and reads the whole response. */
function viaProxy(b: CredentialBroker, target: string, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: LOOPBACK, port: proxyPort(b), path: target, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Opens a CONNECT tunnel; resolves with the status and the tunnel socket. */
function connect(b: CredentialBroker, target: string) {
  return new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
    const req = http.request({ host: LOOPBACK, port: proxyPort(b), method: 'CONNECT', path: target, agent: false });
    req.on('connect', (res: http.IncomingMessage, socket: Socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on('error', reject);
    req.end();
  });
}

describe('createCredentialBroker (LOU-X12)', () => {
  it('injects rule headers into plain-HTTP requests, replacing a client Authorization and dropping hop-by-hop headers', async () => {
    const b = await broker();
    const res = await viaProxy(b, `http://${upstreamHost}/repos?x=1`, {
      authorization: 'Bearer client-supplied',
      connection: 'x-client-hop',
      'x-client-hop': 'drop-me',
      'proxy-authorization': 'Basic abc',
      'x-kept': 'yes',
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ path: '/repos?x=1', authorization: `Bearer ${SECRET}` });
    expect(seen[0]).toMatchObject({ 'x-static': 'static-value', 'x-kept': 'yes', host: upstreamHost });
    expect(seen[0]).not.toHaveProperty('x-client-hop');
    expect(seen[0]).not.toHaveProperty('proxy-authorization');
    expect(res.headers).not.toHaveProperty('x-upstream-hop');
  });

  it('forwards allowlisted hosts without injecting anything, and answers 403 for any other host without connecting', async () => {
    const b = await broker({ rules: {}, allow: [LOOPBACK] });
    const res = await viaProxy(b, `http://${upstreamHost}/plain`, { authorization: 'Bearer own-token' });
    expect(JSON.parse(res.body)).toEqual({ path: '/plain', authorization: 'Bearer own-token' });

    const denied = await viaProxy(b, 'http://not-allowed.invalid/x');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatch(/not on the broker's allowlist/);
    expect(seen).toHaveLength(1);
  });

  it('serves /__broker/<host>/<path> with the injected headers', async () => {
    const b = await broker();
    expect(b.baseUrl(upstreamHost)).toBe(`${b.url}/__broker/${upstreamHost}`);
    const res = await viaProxy(b, `/__broker/${upstreamHost}/user/repos?page=2`);
    expect(JSON.parse(res.body)).toEqual({ path: '/user/repos?page=2', authorization: `Bearer ${SECRET}` });
    expect((await viaProxy(b, '/not-a-broker-path')).status).toBe(400);
  });

  it('refuses hosts that resolve to loopback or private addresses unless explicitly allowed', async () => {
    const b = await broker({ allowPrivate: [] });
    const res = await viaProxy(b, `http://${upstreamHost}/`);
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/private address/);
    expect((await connect(b, `${upstreamHost}`)).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('tunnels CONNECT to allowed targets untouched and refuses others', async () => {
    const b = await broker();
    const denied = await connect(b, 'evil.invalid:443');
    expect(denied.status).toBe(403);
    denied.socket.destroy();

    const { status, socket } = await connect(b, upstreamHost);
    expect(status).toBe(200);
    const reply = new Promise<string>((resolve) => {
      let data = '';
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString();
        if (data.includes('}')) resolve(data);
      });
    });
    socket.write(`GET /tunnelled HTTP/1.1\r\nHost: ${upstreamHost}\r\nConnection: close\r\n\r\n`);
    const body = await reply;
    expect(body).toContain('"path":"/tunnelled"');
    expect(body).toContain('"authorization":null');
  });

  it('never exposes the secret: env, refusals and a failing credential function stay clean', async () => {
    const b = await broker({
      rules: { [LOOPBACK]: { authorization: () => { throw new Error(`token ${SECRET} expired`); } } },
    });
    expect(b.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(b.env).toMatchObject({ HTTP_PROXY: b.url, HTTPS_PROXY: b.url, NO_PROXY: LOOPBACK, http_proxy: b.url, https_proxy: b.url, no_proxy: LOOPBACK });
    expect(JSON.stringify(b.env)).not.toContain(SECRET);
    const res = await viaProxy(b, `http://${upstreamHost}/`);
    expect(res.status).toBe(502);
    expect(res.body).not.toContain(SECRET);
    expect(seen).toHaveLength(0);
  });

  it('validates host patterns', async () => {
    await expect(createCredentialBroker({ rules: { 'https://api.github.com/': {} } })).rejects.toThrow(/host/);
    await expect(createCredentialBroker({ rules: {}, allow: ['a..b'] })).rejects.toThrow(/host/);
  });

  it('close() stops listening and ends open tunnels', async () => {
    const b = await createCredentialBroker({ rules: { [LOOPBACK]: {} }, allowPrivate: [LOOPBACK] });
    const { socket } = await connect(b, upstreamHost);
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
    socket.on('error', () => {});
    await b.close();
    await closed;
    await expect(viaProxy(b, `http://${upstreamHost}/`)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('end to end: a NodeWorkspace command reaches the API through broker.env with the token it never holds', async () => {
    const b = await broker();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-broker-')));
    try {
      const script = [
        "const http = require('node:http');",
        'const proxy = new URL(process.env.HTTP_PROXY);',
        `const target = 'http://${upstreamHost}/e2e';`,
        "const leaked = Object.values(process.env).some((v) => v.includes('fake-broker-secret'));",
        'http.get({ host: proxy.hostname, port: proxy.port, path: target }, (res) => {',
        "  let body = ''; res.on('data', (c) => (body += c));",
        "  res.on('end', () => process.stdout.write(JSON.stringify({ leaked, body: JSON.parse(body) })));",
        '});',
      ].join('\n');
      fs.writeFileSync(path.join(root, 'call.js'), script);
      const workspace = new NodeWorkspace({ root, env: { ...b.env } });
      const result = await workspace.exec(`${JSON.stringify(process.execPath)} call.js`);
      expect(JSON.parse(result.stdout)).toEqual({ leaked: false, body: { path: '/e2e', authorization: `Bearer ${SECRET}` } });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
