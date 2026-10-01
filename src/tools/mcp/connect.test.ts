import { describe, it, expect, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createAgent } from '../../createAgent';
import { specToAgent } from '../../spec/specToAgent';
import { mockModel } from '../../testing';
import { defineTool } from '../defineTool';
import type { Logger } from '../../execution/logger';
import { connectMcp, type McpConnections } from './connect';
import { serveMcp } from './server/serveMcp';

const fixture = fileURLToPath(new URL('./__fixtures__/stdioServer.mjs', import.meta.url));
const stdio = (prefix = '') => ({ command: process.execPath, args: [fixture], env: { FIXTURE_PREFIX: prefix } });

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connect(...args: Parameters<typeof connectMcp>): Promise<McpConnections> {
  const connections = await connectMcp(...args);
  closers.push(() => connections.close());
  return connections;
}

async function callEcho(connections: McpConnections, name: string, text: string): Promise<unknown> {
  return connections.tools[name].tool.execute!({ text }, { toolCallId: 'c1', messages: [] });
}

function warnLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('connectMcp (LOU-Z4)', () => {
  it('connects a stdio server, namespaces its tools and calls them with the given env', async () => {
    const mcp = await connect({ files: stdio('hi:') });
    expect(Object.keys(mcp.tools)).toEqual(['files__echo', 'files__wipe']);
    expect(mcp.status()).toEqual({ files: 'connected' });
    await expect(callEcho(mcp, 'files__echo', 'ping')).resolves.toMatchObject({ text: 'hi:ping' });
  });

  it('close() disconnects; with lazy (default) the next tool call reconnects', async () => {
    const mcp = await connect({ files: stdio() });
    await mcp.close();
    expect(mcp.status()).toEqual({ files: 'idle' });
    await expect(callEcho(mcp, 'files__echo', 'again')).resolves.toMatchObject({ text: 'again' });
    expect(mcp.status()).toEqual({ files: 'connected' });
  });

  it('with lazy: false a tool call after close() fails', async () => {
    const mcp = await connect({ files: stdio() }, { lazy: false });
    await mcp.close();
    await expect(callEcho(mcp, 'files__echo', 'x')).rejects.toThrow(/MCP server 'files' is closed/);
  });

  it("onError: 'skip' leaves out a server that cannot connect, with a warning", async () => {
    const logger = warnLogger();
    const mcp = await connect(
      { files: stdio(), broken: { command: 'loushy-no-such-command-z4' } },
      { onError: 'skip', logger }
    );
    expect(Object.keys(mcp.tools)).toEqual(['files__echo', 'files__wipe']);
    expect(mcp.status()).toEqual({ files: 'connected', broken: 'failed' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("skipping MCP server 'broken'"),
      expect.objectContaining({ server: 'broken' })
    );
  });

  it('rejects by default when a server cannot connect, naming it', async () => {
    await expect(connectMcp({ files: stdio(), broken: { command: 'loushy-no-such-command-z4' } })).rejects.toThrow(
      /connectMcp: MCP server 'broken' failed to connect/
    );
  });

  it('passes each server its own approval and keeps the annotations on the descriptor (LOU-Z5)', async () => {
    const mcp = await connect({ strict: { ...stdio(), approval: 'always' }, loose: { ...stdio(), approval: 'never' }, auto: stdio() });
    const asks = (name: string) => mcp.tools[name].needsApproval;
    expect([asks('strict__echo'), asks('loose__wipe'), asks('auto__echo'), asks('auto__wipe')]).toEqual([true, false, false, true]);
    expect(mcp.tools.auto__echo.displayName).toBe('Echo');
    expect(mcp.tools.auto__echo.metadata).toEqual({ mcp: { annotations: { title: 'Echo', readOnlyHint: true } } });
  });

  it('connects a streamable HTTP server with headers', async () => {
    const searchDocs = defineTool({
      name: 'search_docs',
      description: 'Search the docs',
      input: z.object({ query: z.string() }),
      execute: ({ query }) => `results for ${query}`,
    });
    const server = await serveMcp({
      agent: createAgent({ provider: mockModel(['ok']) }),
      name: 'docs',
      tools: [searchDocs],
      transport: { type: 'http', port: 0, auth: { type: 'bearer', token: 'secret' } },
      warn: () => {},
    });
    closers.push(() => server.close());

    const mcp = await connect({ docs: { url: server.url!, headers: { Authorization: 'Bearer secret' } } });
    expect(Object.keys(mcp.tools).sort()).toEqual(['docs__docs', 'docs__search_docs']);
    const result = await mcp.tools.docs__search_docs.tool.execute!({ query: 'mcp' }, { toolCallId: 'c1', messages: [] });
    expect(result).toMatchObject({ text: 'results for mcp' });

    await expect(connectMcp({ docs: { url: server.url! } })).rejects.toThrow(/'docs' failed to connect/);
  });
});

describe('createAgent({ mcpServers }) (LOU-Z4)', () => {
  it('connects on the first send() and runs an MCP tool', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'files__echo', args: { text: 'ping' } }] }, 'done']);
    const agent = createAgent({ provider: model, mcpServers: { files: stdio('mcp:') } });
    closers.push(() => agent.close());

    const result = await agent.send('echo ping');
    expect(result.text).toBe('done');
    expect(model.calls[0].tools?.map((t) => t.function.name)).toEqual(['files__echo', 'files__wipe']);
    expect(JSON.stringify(result.messages)).toContain('mcp:ping');
  });

  it('stream() waits for the servers, and ready() / close() are no-ops without them', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'files__echo', args: { text: 'x' } }] }, 'streamed']);
    const agent = createAgent({ provider: model, mcpServers: { files: stdio() } });
    closers.push(() => agent.close());
    const types: string[] = [];
    for await (const event of agent.stream('go')) types.push(event.type);
    expect(types).toContain('tool.done');
    expect(types.at(-1)).toBe('run.done');

    const plain = createAgent({ provider: mockModel(['hi']) });
    await expect(plain.ready()).resolves.toBeUndefined();
    await expect(plain.close()).resolves.toBeUndefined();
  });

  it('send() rejects when a server cannot connect, and retries on the next call', async () => {
    const agent = createAgent({ provider: mockModel(['a', 'b']), mcpServers: { broken: { command: 'loushy-no-such-command-z4' } } });
    await expect(agent.send('hi')).rejects.toThrow(/'broken' failed to connect/);
    await expect(agent.ready()).rejects.toThrow(/'broken' failed to connect/);
    await expect(agent.close()).resolves.toBeUndefined();
  });

  it('a destructive MCP tool pauses the run for approval; a readOnly one runs (LOU-Z5)', async () => {
    const wipe = { toolCalls: [{ name: 'files__wipe', args: { path: '/data' }, id: 'call_wipe' }] };
    const agent = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'files__echo', args: { text: 'hi' } }] }, wipe, 'wiped.']),
      mcpServers: { files: stdio() },
    });
    closers.push(() => agent.close());

    const paused = await agent.send('clean up');
    expect(paused.finishReason).toBe('awaiting-approval');
    const [pending] = await agent.approvals.list();
    expect(pending).toMatchObject({ toolName: 'files__wipe', args: { path: '/data' } });
    expect(JSON.stringify(paused.messages)).toContain('hi'); // the readOnly echo ran without asking

    const done = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(done.finishReason).toBe('stop');
    expect(JSON.stringify(done.messages)).toContain('wiped /data');
  });

  it("approval: 'never' on the server entry lets the destructive tool run (LOU-Z5)", async () => {
    const wipe = { toolCalls: [{ name: 'files__wipe', args: { path: '/tmp/x' } }] };
    const agent = createAgent({
      provider: mockModel([wipe, 'done']),
      mcpServers: { files: { ...stdio(), approval: 'never' } },
    });
    closers.push(() => agent.close());
    const result = await agent.send('clean up');
    expect(result.finishReason).toBe('stop');
    expect(JSON.stringify(result.messages)).toContain('wiped /tmp/x');
  });

  it('specToAgent() connects spec.mcpServers', async () => {
    const agent = specToAgent({ name: 'spec-mcp', prompt: 'p', provider: { type: 'mock', model: 'm' }, mcpServers: { files: stdio() } });
    closers.push(() => agent.close());
    await agent.ready();
    expect(agent.mcpServers).toEqual({ files: stdio() });
    const result = await agent.send('hi');
    expect(result.text).toBeTypeOf('string');
  });
});
