import { describe, it, expect, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { createAgent } from '../../createAgent';
import { specToAgent } from '../../spec/specToAgent';
import { mockModel } from '../../testing';
import { defineTool } from '../defineTool';
import type { Logger } from '../../execution/logger';
import { connectMcp, McpStartError, type McpConnections } from './connect';
import { serveMcp } from './server/serveMcp';

const fixture = fileURLToPath(new URL('./__fixtures__/stdioServer.mjs', import.meta.url));
const failing = fileURLToPath(new URL('./__fixtures__/failingServer.mjs', import.meta.url));
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
      { files: stdio(), broken: { command: 'lousho-no-such-command-z4' } },
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
    await expect(connectMcp({ files: stdio(), broken: { command: 'lousho-no-such-command-z4' } })).rejects.toThrow(
      /MCP server 'broken' failed to start/
    );
  });

  it('passes each server its own approval and keeps the annotations on the descriptor (LOU-Z5)', async () => {
    const mcp = await connect({
      strict: { ...stdio(), approval: 'always' },
      loose: { ...stdio(), approval: 'never' },
      auto: { ...stdio(), approval: 'annotations' },
      plain: stdio(),
    });
    const asks = (name: string) => mcp.tools[name].needsApproval;
    expect([asks('strict__echo'), asks('loose__wipe'), asks('auto__echo'), asks('auto__wipe')]).toEqual([true, false, false, true]);
    // Eve TOOLS-F11: by default every MCP tool asks, whatever its server's hints say.
    expect([asks('plain__echo'), asks('plain__wipe')]).toEqual([true, true]);
    expect(mcp.tools.auto__echo.displayName).toBe('Echo');
    expect(mcp.tools.auto__echo.metadata).toEqual({ mcp: { annotations: { title: 'Echo', readOnlyHint: true }, server: 'auto', tool: 'echo' } });
    expect(mcp.tools.plain__echo.metadata?.mcp?.annotationsTrusted).toBe(false);
  });

  it('timeoutMs on the server entry bounds each tool call (audit D4)', async () => {
    const mcp = await connect({ slow: { ...stdio(), env: { FIXTURE_DELAY_MS: '5000' }, timeoutMs: 100 } });
    await expect(callEcho(mcp, 'slow__echo', 'x')).rejects.toThrow(/timed out/i);
  });

  it('a server that exits while starting fails with LOUSHO_MCP_START_FAILED, its exit code and its last stderr lines (audit D4)', async () => {
    const error = (await connectMcp({ broken: { command: process.execPath, args: [failing], env: { FIXTURE_MODE: 'exit' }, stderr: 'capture' } }).catch(
      (e: unknown) => e
    )) as McpStartError;
    expect(error).toBeInstanceOf(McpStartError);
    expect(error.code).toBe('LOUSHO_MCP_START_FAILED');
    expect(error.exitCode).toBe(3);
    expect(error.stderr).toContain('npm error 404 Not Found');
    expect(error.stderr).not.toMatch(/^log line 1$/m);
    expect(error.message).toMatch(/MCP server 'broken' failed to start/);
    expect(error.message).toContain('exit code 3');
    expect(error.message).toContain('npm error 404');
  });

  it('connectTimeoutMs bounds the start of a server that never answers (audit D4)', async () => {
    const started = Date.now();
    const error = (await connectMcp({
      mute: { command: process.execPath, args: [failing], env: { FIXTURE_MODE: 'silent' }, connectTimeoutMs: 200 },
    }).catch((e: unknown) => e)) as McpStartError;
    expect(error).toBeInstanceOf(McpStartError);
    expect(error.message).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('cwd sets the working directory of a stdio server (audit D4)', async () => {
    const dir = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
    const mcp = await connect({ files: { command: process.execPath, args: ['stdioServer.mjs'], cwd: dir } });
    await expect(callEcho(mcp, 'files__echo', 'x')).resolves.toMatchObject({ text: 'x' });
  });

  it('tools.include / tools.exclude on the server entry filter its tools (audit D4)', async () => {
    const mcp = await connect({ ro: { ...stdio(), tools: { exclude: ['wipe'] } }, only: { ...stdio(), tools: { include: ['wipe'] } } });
    expect(Object.keys(mcp.tools)).toEqual(['ro__echo', 'only__wipe']);
  });

  it('N2: a server with deferLoading marks every one of its tools deferLoading; others are not', async () => {
    const mcp = await connect({ deferred: { ...stdio(), deferLoading: true }, plain: stdio() });
    expect([mcp.tools.deferred__echo.deferLoading, mcp.tools.deferred__wipe.deferLoading]).toEqual([true, true]);
    expect([mcp.tools.plain__echo.deferLoading, mcp.tools.plain__wipe.deferLoading]).toEqual([undefined, undefined]);
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
    const agent = createAgent({ provider: model, mcpServers: { files: { ...stdio('mcp:'), approval: 'annotations' } } });
    closers.push(() => agent.close());

    const result = await agent.send('echo ping');
    expect(result.text).toBe('done');
    expect(model.calls[0].tools?.map((t) => t.function.name)).toEqual(['files__echo', 'files__wipe']);
    expect(JSON.stringify(result.messages)).toContain('mcp:ping');
  });

  it('stream() waits for the servers, and ready() / close() are no-ops without them', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'files__echo', args: { text: 'x' } }] }, 'streamed']);
    const agent = createAgent({ provider: model, mcpServers: { files: { ...stdio(), approval: 'annotations' } } });
    closers.push(() => agent.close());
    const types: string[] = [];
    for await (const event of agent.stream('go')) types.push(event.type);
    expect(types).toContain('tool.done');
    expect(types.at(-1)).toBe('run.done');

    const plain = createAgent({ provider: mockModel(['hi']) });
    await expect(plain.ready()).resolves.toBeUndefined();
    await expect(plain.close()).resolves.toBeUndefined();
  });

  it('ready() after close() reconnects the servers (audit D4)', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'lousho-mcp-')), 'starts.log');
    closers.push(async () => rmSync(dirname(log), { recursive: true, force: true }));
    const agent = createAgent({ provider: mockModel(['a']), mcpServers: { files: { ...stdio(), env: { FIXTURE_START_LOG: log } } } });
    closers.push(() => agent.close());
    await agent.ready();
    await agent.close();
    await agent.ready();
    expect(readFileSync(log, 'utf8').match(/start/g)).toHaveLength(2);
  });

  it('send() rejects when a server cannot connect, and retries on the next call', async () => {
    const agent = createAgent({ provider: mockModel(['a', 'b']), mcpServers: { broken: { command: 'lousho-no-such-command-z4' } } });
    await expect(agent.send('hi')).rejects.toThrow(/'broken' failed to start/);
    await expect(agent.ready()).rejects.toThrow(/'broken' failed to start/);
    await expect(agent.close()).resolves.toBeUndefined();
  });

  it("Eve TOOLS-F11: by default a readOnlyHint MCP tool still pauses for approval", async () => {
    const agent = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'files__echo', args: { text: 'hi' } }] }, 'done']),
      mcpServers: { files: stdio() },
    });
    closers.push(() => agent.close());
    const result = await agent.send('echo');
    expect(result.finishReason).toBe('awaiting-approval');
  });

  it("Eve TOOLS-F11: plan mode refuses a server's readOnlyHint tool unless approval is 'annotations'", async () => {
    const echo = { toolCalls: [{ name: 'files__echo', args: { text: 'hi' }, id: 'call_echo' }] };
    const run = async (approval?: 'annotations') => {
      const model = mockModel([echo, 'done']);
      const agent = createAgent({
        provider: model,
        permissionMode: 'plan',
        mcpServers: { files: { ...stdio(), ...(approval && { approval }) } },
      });
      closers.push(() => agent.close());
      const result = await agent.send('echo');
      return JSON.stringify(result.messages);
    };
    expect(await run()).toMatch(/plan mode/i);
    expect(await run('annotations')).toContain('hi');
  });

  it('Eve TOOLS-F11: an MCP tool with the name of a local tool is refused (LOUSHO_CONFIG_INVALID)', async () => {
    let ran = false;
    const local = defineTool({
      name: 'files__wipe',
      description: 'local, gated',
      input: z.object({}),
      needsApproval: true,
      execute: async () => {
        ran = true;
        return 'local';
      },
    });
    const agent = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'files__wipe', args: {} }] }, 'done']),
      tools: [local],
      mcpServers: { files: { ...stdio(), approval: 'never' } },
    });
    closers.push(() => agent.close());
    await expect(agent.send('go')).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID', message: expect.stringContaining("'files__wipe'") });
    expect(ran).toBe(false);
  });

  it('a destructive MCP tool pauses the run for approval; a readOnly one runs (LOU-Z5)', async () => {
    const wipe = { toolCalls: [{ name: 'files__wipe', args: { path: '/data' }, id: 'call_wipe' }] };
    const agent = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'files__echo', args: { text: 'hi' } }] }, wipe, 'wiped.']),
      mcpServers: { files: { ...stdio(), approval: 'annotations' } },
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

  it('an approval function sees the call arguments (audit D4)', async () => {
    const wipe = (path: string, id: string) => ({ toolCalls: [{ name: 'files__wipe', args: { path }, id }] });
    const agent = createAgent({
      provider: mockModel([wipe('/tmp/x', 'call_tmp'), wipe('/data', 'call_data'), 'done']),
      mcpServers: { files: { ...stdio(), approval: ({ args }) => !String(args?.path).startsWith('/tmp/') } },
    });
    closers.push(() => agent.close());
    const paused = await agent.send('clean up');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(JSON.stringify(paused.messages)).toContain('wiped /tmp/x');
    const [pending] = await agent.approvals.list();
    expect(pending).toMatchObject({ toolName: 'files__wipe', args: { path: '/data' } });
  });

  it("N2: a deferLoading server's tools are withheld until tool_search finds them; the prompt names the server", async () => {
    const model = mockModel([{ toolCalls: [{ name: 'tool_search', args: { query: 'echo text' }, id: 'call_search' }] }, 'done']);
    const agent = createAgent({ provider: model, mcpServers: { files: { ...stdio(), deferLoading: true } }, toolSearch: { thresholdPercent: 0 } });
    closers.push(() => agent.close());
    await agent.send('echo ping');
    expect(model.calls[0].tools?.map((t) => t.function.name)).toEqual(['tool_search']);
    expect(model.calls[0].messages[0].content).toContain("2 more tools are available but not loaded yet (2 from the MCP server 'files')");
    expect(model.calls[1].tools?.map((t) => t.function.name)).toEqual(['files__echo', 'tool_search']);
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
