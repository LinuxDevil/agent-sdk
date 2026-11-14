import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2, SimpleAgent } from 'lousho';
import { ConfigurationError, createAgent } from 'lousho';
import { mockModel } from 'lousho/testing';
import type { ServeMcpHandle, ServeMcpOptions } from 'lousho/mcp';
import { AgentRepo } from '../storage/agentRepo';
import { VersionStore } from '../storage/versionStore';
import { ServeConfigStore } from '../serve/serveConfigStore';
import { McpNotPublishedError, McpServerManager } from '../serve/mcpServers';
import { publishAgent } from '../lifecycle/publish';
import { StudioEventBus } from '../events/eventBus';

const SPEC: AgentSpecV2 = { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Check the queues.', description: 'Ops helper' };

interface FakeServe {
  options: ServeMcpOptions[];
  handles: ServeMcpHandle[];
  impl: (options: ServeMcpOptions) => Promise<ServeMcpHandle>;
}

/** A `serve` seam that answers a fresh ephemeral-looking handle per call and records every option set. */
function fakeServe(): FakeServe {
  const fake: FakeServe = {
    options: [],
    handles: [],
    impl: async (options) => {
      fake.options.push(options);
      const port = 40000 + fake.handles.length;
      const handle: ServeMcpHandle = {
        agentToolName: 'ask_ops',
        url: `http://127.0.0.1:${port}/mcp`,
        port,
        close: vi.fn(async () => {}),
      };
      fake.handles.push(handle);
      return handle;
    },
  };
  return fake;
}

describe('McpServerManager (X03)', () => {
  let baseDir: string;
  let repo: AgentRepo;
  let versions: VersionStore;
  let serveConfig: ServeConfigStore;
  let events: StudioEventBus;
  let serve: FakeServe;
  let builds: { spec: AgentSpecV2; agentId: string }[];
  let manager: McpServerManager;

  const agent = { send: vi.fn() } as unknown as SimpleAgent;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-x03-mcp-'));
    repo = new AgentRepo(baseDir);
    versions = new VersionStore(repo);
    serveConfig = new ServeConfigStore(path.join(baseDir, '.lousho', 'serve.json'));
    events = new StudioEventBus();
    serve = fakeServe();
    builds = [];
    await repo.writeSpec('ops', SPEC);
    manager = new McpServerManager({
      repo,
      versions,
      serveConfig,
      buildAgent: async (spec, agentId) => {
        builds.push({ spec, agentId });
        return agent;
      },
      serve: serve.impl,
    });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  async function publish(id = 'ops'): Promise<number> {
    const { publishedVersion } = await publishAgent(id, {}, { repo, versions, events, baseDir });
    return publishedVersion;
  }

  it('rejects start with McpNotPublishedError when nothing is published', async () => {
    await expect(manager.start('ops')).rejects.toBeInstanceOf(McpNotPublishedError);
    expect(serve.options).toHaveLength(0);
  });

  it('starts on the published version with the serve bearer and loopback http transport', async () => {
    await publish();
    const entry = await serveConfig.get('ops');
    const status = await manager.start('ops');
    expect(status).toEqual({
      running: true,
      url: 'http://127.0.0.1:40000/mcp',
      port: 40000,
      version: 1,
      toolName: 'ask_ops',
    });
    expect(builds).toEqual([{ spec: SPEC, agentId: 'ops' }]);
    const options = serve.options[0];
    expect(options.name).toBe('ops');
    expect(options.description).toBe('Ops helper');
    expect(options.transport).toMatchObject({
      type: 'http',
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      auth: { type: 'bearer', token: entry.token },
    });
  });

  it('is idempotent while the published version is unchanged', async () => {
    await publish();
    await manager.start('ops');
    const again = await manager.start('ops');
    expect(again.running).toBe(true);
    expect(serve.options).toHaveLength(1);
    expect(builds).toHaveLength(1);
  });

  it('stop closes the handle and reports stopped', async () => {
    await publish();
    await manager.start('ops');
    const status = await manager.stop('ops');
    expect(status.running).toBe(false);
    expect(serve.handles[0].close).toHaveBeenCalledOnce();
    // Stopping twice is a no-op.
    await manager.stop('ops');
    expect(serve.handles[0].close).toHaveBeenCalledOnce();
  });

  it('refresh restarts a running server when the published version moves', async () => {
    await publish();
    await manager.start('ops');
    await repo.writeSpec('ops', { ...SPEC, instructions: 'New instructions.' });
    const v2 = await publish();
    expect(v2).toBe(2);
    await manager.refresh('ops');
    const status = manager.status('ops');
    expect(status.version).toBe(2);
    expect(status.url).toBe('http://127.0.0.1:40001/mcp');
    expect(serve.handles[0].close).toHaveBeenCalledOnce();
    expect(serve.options).toHaveLength(2);
  });

  it('refresh is a no-op for a stopped server and for an unchanged version', async () => {
    await publish();
    await manager.refresh('ops');
    expect(serve.options).toHaveLength(0);
    await manager.start('ops');
    await manager.refresh('ops');
    expect(serve.options).toHaveLength(1);
  });

  it('refresh stops the server when the agent loses its publish pointer', async () => {
    await publish();
    await manager.start('ops');
    const meta = await repo.readMeta('ops');
    await repo.writeMeta('ops', { ...meta, publishedVersion: null });
    await manager.refresh('ops');
    expect(manager.status('ops').running).toBe(false);
    expect(serve.handles[0].close).toHaveBeenCalledOnce();
  });

  it('restart picks up a rotated token', async () => {
    await publish();
    await manager.start('ops');
    const oldToken = serve.options[0].transport !== 'stdio' && typeof serve.options[0].transport === 'object'
      ? (serve.options[0].transport as { auth?: { token: string } }).auth?.token
      : undefined;
    const newToken = await serveConfig.rotateToken('ops');
    await manager.restart('ops');
    const next = serve.options[1].transport;
    const nextToken = typeof next === 'object' && next !== null ? (next as { auth?: { token: string } }).auth?.token : undefined;
    expect(oldToken).toBeDefined();
    expect(nextToken).toBe(newToken);
    expect(nextToken).not.toBe(oldToken);
  });

  it('restart is a no-op while stopped', async () => {
    await publish();
    await manager.restart('ops');
    expect(serve.options).toHaveLength(0);
  });

  it('closeAll stops every running server', async () => {
    await repo.writeSpec('beta', SPEC);
    await publish('ops');
    await publish('beta');
    await manager.start('ops');
    await manager.start('beta');
    await manager.closeAll();
    expect(manager.status('ops').running).toBe(false);
    expect(manager.status('beta').running).toBe(false);
    expect(serve.handles[0].close).toHaveBeenCalledOnce();
    expect(serve.handles[1].close).toHaveBeenCalledOnce();
  });

  it('propagates the SDK ConfigurationError when the MCP peer is missing', async () => {
    await publish();
    const peerless = new McpServerManager({
      repo,
      versions,
      serveConfig,
      buildAgent: async () => agent,
      serve: async () => {
        throw new ConfigurationError('serveMcp: optional peer @modelcontextprotocol/sdk is not installed', 'mcp');
      },
    });
    await expect(peerless.start('ops')).rejects.toBeInstanceOf(ConfigurationError);
    expect(peerless.status('ops').running).toBe(false);
  });

  it('serves tools/list over real HTTP with the serve bearer (skips without the MCP peer)', async (ctx) => {
    await publish();
    // No `serve` seam: the manager calls the SDK's real serveMcp, which
    // loads @modelcontextprotocol/sdk as an optional peer.
    const realAgent = createAgent({
      prompt: 'p',
      provider: mockModel(['pong'], { onExhausted: 'repeat-last' }),
    });
    const real = new McpServerManager({
      repo,
      versions,
      serveConfig,
      buildAgent: async () => realAgent,
    });
    let status;
    try {
      status = await real.start('ops');
    } catch (error) {
      if (error instanceof ConfigurationError) return ctx.skip();
      throw error;
    }
    expect(status.running).toBe(true);
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const { token } = await serveConfig.get('ops');
    const post = (auth?: string) =>
      fetch(status.url!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(auth !== undefined ? { Authorization: `Bearer ${auth}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    const unauthorized = await post();
    expect(unauthorized.status).toBe(401);
    const listed = await post(token);
    expect(listed.status).toBe(200);
    const body = await listed.text();
    expect(body).toContain('"name":"ops"');
    await real.closeAll();
  });
});
