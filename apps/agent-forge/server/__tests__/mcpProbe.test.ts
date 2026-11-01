import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import type { NamedToolDescriptor } from 'lousho';
import type { connectMcp, McpConnections } from 'lousho/mcp';
import { createApp } from '../app';
import { STUDIO_TOKEN_HEADER } from '../auth';
import { registerMcpProbeRoute } from '../routes/mcpProbe';
import { SecretsStore } from '../secretsStore';
import { sdkRootDir } from '../sdkRoot';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import type { McpServerSpecV2 } from '../../shared/wireTypes';

/**
 * `POST /catalog/mcp/probe` connects one MCP server (secret refs resolved),
 * lists its tools, disconnects and answers `{ ok, tools?, error? }` - the MCP
 * node's Probe button and the Author's `probeMcpServer` tool read it. Most
 * cases run through `createApp` (the real wiring, token gate included) with
 * an injected `connect`; the timeout case mounts the route on a bare app so
 * `timeoutMs` can drop to 50 ms, and the last case probes the SDK's real
 * stdio fixture server end-to-end.
 */
const TOKEN = 'mcp-probe-token-0123456789';

/** A fake `NamedToolDescriptor`: only `name` and `tool.description` matter to the route. */
function descriptor(name: string, description: string): NamedToolDescriptor {
  return { name, displayName: name, tool: { description } } as NamedToolDescriptor;
}

/** A `McpConnections` stub plus the `close` spy the assertions check. */
function connStub(tools: Record<string, NamedToolDescriptor> = {}) {
  const close = vi.fn(async (): Promise<void> => {});
  const conn: McpConnections = { tools, close, reconnect: async () => {}, status: () => ({}) };
  return { conn, close };
}

describe('POST /catalog/mcp/probe', () => {
  let baseDir: string;
  let secretsStore: SecretsStore;
  let agentStore: ReturnType<typeof createFsAgentStore>;
  let runManager: RunManager;

  function makeApp(mcpConnect?: typeof connectMcp): Express {
    return createApp({
      agentStore,
      runManager,
      baseDir,
      secretsStore,
      access: { token: TOKEN },
      ...(mcpConnect ? { mcpConnect } : {}),
    });
  }

  function authed(app: Express) {
    return request(app).post('/catalog/mcp/probe').set(STUDIO_TOKEN_HEADER, TOKEN);
  }

  beforeAll(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-probe-'));
    secretsStore = new SecretsStore(baseDir);
    agentStore = createFsAgentStore(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
    });
  });

  afterAll(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('lists the connected server\u2019s tools without the probe__ prefix, then closes once', async () => {
    const { conn, close } = connStub({ probe__b: descriptor('probe__b', 'Bee tool'), probe__a: descriptor('probe__a', 'Ay tool') });
    const connect = vi.fn(async () => conn) as unknown as typeof connectMcp;
    const res = await authed(makeApp(connect)).send({ server: { command: 'probe-cmd' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      tools: [
        { name: 'a', description: 'Ay tool' },
        { name: 'b', description: 'Bee tool' },
      ],
    });
    expect(connect).toHaveBeenCalledWith({ probe: { command: 'probe-cmd' } }, { lazy: false, onError: 'throw' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('drops the tools filter and optional flag before connecting', async () => {
    const { conn } = connStub();
    const connect = vi.fn(async () => conn) as unknown as typeof connectMcp;
    const server: McpServerSpecV2 = { command: 'probe-cmd', tools: { include: ['a'] }, optional: true };
    const res = await authed(makeApp(connect)).send({ server });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, tools: [] });
    const servers = vi.mocked(connect).mock.calls[0][0];
    expect(servers.probe).not.toHaveProperty('tools');
    expect(servers.probe).not.toHaveProperty('optional');
  });

  it('answers ok:false with the 10s message when the server does not answer, and still closes when connect resolves later', async () => {
    const { conn, close } = connStub();
    let resolveConnect: (conn: McpConnections) => void = () => {};
    const pending = new Promise<McpConnections>((resolve) => {
      resolveConnect = resolve;
    });
    const connect = vi.fn(() => pending) as unknown as typeof connectMcp;
    // Bare mount: timeoutMs is a test dep (createApp wires the real 10 s).
    const app = express();
    app.use(express.json());
    registerMcpProbeRoute(app, { resolveSecret: () => undefined, connect, timeoutMs: 50 });
    const res = await request(app).post('/catalog/mcp/probe').send({ server: { command: 'hang' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: 'The server did not answer within 10 seconds.' });
    // The connect that outlived the probe is closed once it finally lands.
    resolveConnect(conn);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it('resolves { secret } refs through the secrets store before connecting', async () => {
    secretsStore.setSecret('GH_TOKEN', 'probe-test-token-value');
    try {
      const { conn } = connStub();
      const connect = vi.fn(async () => conn) as unknown as typeof connectMcp;
      const server: McpServerSpecV2 = { url: 'http://127.0.0.1:1/mcp', headers: { Authorization: { secret: 'GH_TOKEN' } } };
      const res = await authed(makeApp(connect)).send({ server });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, tools: [] });
      const servers = vi.mocked(connect).mock.calls[0][0];
      expect('headers' in servers.probe ? servers.probe.headers : undefined).toEqual({
        Authorization: 'probe-test-token-value',
      });
    } finally {
      secretsStore.removeSecret('GH_TOKEN');
    }
  });

  it('answers ok:false naming the missing secret, and never connects', async () => {
    const connect = vi.fn() as unknown as typeof connectMcp;
    const server: McpServerSpecV2 = { url: 'http://127.0.0.1:1/mcp', headers: { Authorization: { secret: 'GH_TOKEN' } } };
    const res = await authed(makeApp(connect)).send({ server });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: "Secret 'GH_TOKEN' is not set. Add it in Settings \u2192 Secrets." });
    expect(connect).not.toHaveBeenCalled();
  });

  it('answers ok:false naming a missing { env } variable, and never connects', async () => {
    vi.stubEnv('MCP_PROBE_MISSING_ENV', '');
    const connect = vi.fn() as unknown as typeof connectMcp;
    const server: McpServerSpecV2 = { command: 'probe-cmd', env: { FLAG: { env: 'MCP_PROBE_MISSING_ENV' } } };
    const res = await authed(makeApp(connect)).send({ server });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: "Environment variable 'MCP_PROBE_MISSING_ENV' is not set." });
    expect(connect).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('400 LOUSHO_SPEC_INVALID for a server with both command and url', async () => {
    const res = await authed(makeApp(vi.fn() as unknown as typeof connectMcp)).send({ server: { command: 'x', url: 'y' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOUSHO_SPEC_INVALID');
    expect(Array.isArray(res.body.details?.issues)).toBe(true);
    expect(res.body.details.issues.length).toBeGreaterThan(0);
  });

  it('400 LOUSHO_BODY_INVALID when the body has no server object', async () => {
    const res = await authed(makeApp(vi.fn() as unknown as typeof connectMcp)).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOUSHO_BODY_INVALID');
  });

  it('401 without the token', async () => {
    const res = await request(makeApp(vi.fn() as unknown as typeof connectMcp))
      .post('/catalog/mcp/probe')
      .send({ server: { command: 'probe-cmd' } });
    expect(res.status).toBe(401);
  });

  it('a thrown connect error answers ok:false with its message', async () => {
    const connect = vi.fn(async () => {
      throw new Error('connectMcp: MCP server blew up');
    }) as unknown as typeof connectMcp;
    const res = await authed(makeApp(connect)).send({ server: { command: 'broken' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: 'connectMcp: MCP server blew up' });
  });

  it('probes the SDK\u2019s real stdio fixture server (no injected connect)', async () => {
    const fixture = path.join(sdkRootDir(), 'src', 'tools', 'mcp', '__fixtures__', 'stdioServer.mjs');
    if (!fs.existsSync(fixture)) return; // no runnable fixture in this layout
    const res = await authed(makeApp()).send({ server: { command: process.execPath, args: [fixture] } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tools).toEqual([
      { name: 'echo', description: 'Echoes text, prefixed with FIXTURE_PREFIX' },
      { name: 'wipe', description: 'Pretends to delete everything (destructiveHint, so it asks for approval)' },
    ]);
  }, 15_000);
});
