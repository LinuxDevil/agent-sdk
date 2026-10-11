import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgent, type SimpleAgent } from '../../../createAgent';
import { defineTool } from '../../defineTool';
import { mockModel } from '../../../testing';
import { buildServer, sanitizeToolName, type ServerSpec } from './buildServer';
import { serveMcp, type ServeMcpHandle } from './serveMcp';

const searchDocs = defineTool({
  name: 'search_docs',
  description: 'Search the docs',
  input: z.object({ query: z.string() }),
  execute: ({ query }) => `results for ${query}`,
});

const deleteAll = defineTool({
  name: 'delete_all',
  description: 'Deletes everything',
  input: z.object({}),
  needsApproval: true,
  execute: () => 'deleted',
});

const brokenTool = defineTool({
  name: 'broken',
  description: 'Always fails',
  input: z.object({}),
  execute: () => {
    throw new Error('boom');
  },
});

function spec(agent: SimpleAgent, overrides: Partial<ServerSpec> = {}): ServerSpec {
  return {
    agent,
    name: 'support-bot',
    version: '1.0.0',
    agentToolName: 'support-bot',
    tools: [],
    allowApprovalTools: false,
    ...overrides,
  };
}

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connect(serverSpec: ServerSpec): Promise<Client> {
  const server = await buildServer(serverSpec);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(() => client.close(), () => server.close());
  return client;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((c) => c.text).join('');
}

describe('serveMcp agent tool', () => {
  it('lists the agent as one tool with a { message } input schema', async () => {
    const agent = createAgent({ prompt: 'p', provider: mockModel(['hi']) });
    const client = await connect(spec(agent, { description: 'Ask the support agent a question' }));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('support-bot');
    expect(tools[0].description).toBe('Ask the support agent a question');
    expect(tools[0].inputSchema).toMatchObject({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    });
  });

  it("calls agent.send and returns the agent's text", async () => {
    const model = mockModel(['Reset it from Settings.']);
    const agent = createAgent({ prompt: 'p', provider: model });
    const client = await connect(spec(agent));
    const result = await client.callTool({ name: 'support-bot', arguments: { message: 'How do I reset?' } });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe('Reset it from Settings.');
    expect(JSON.stringify(model.lastCall)).toContain('How do I reset?');
  });

  it('treats each call as a fresh conversation', async () => {
    const model = mockModel(['one', 'two']);
    const client = await connect(spec(createAgent({ prompt: 'p', provider: model })));
    await client.callTool({ name: 'support-bot', arguments: { message: 'first' } });
    await client.callTool({ name: 'support-bot', arguments: { message: 'second' } });
    expect(JSON.stringify(model.lastCall)).not.toContain('first');
  });

  it('rejects arguments that do not match the schema', async () => {
    const client = await connect(spec(createAgent({ prompt: 'p', provider: mockModel(['x']) })));
    const result = await client.callTool({ name: 'support-bot', arguments: { message: 42 } });
    expect(result.isError).toBe(true);
  });

  it('returns isError when the agent throws', async () => {
    const agent = { send: vi.fn().mockRejectedValue(new Error('model down')) };
    const client = await connect(spec(agent as unknown as SimpleAgent));
    const result = await client.callTool({ name: 'support-bot', arguments: { message: 'hi' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('model down');
  });

  it('returns isError when the model reports an error', async () => {
    const model = mockModel([{ text: 'rate limited', finishReason: 'error' }]);
    const client = await connect(spec(createAgent({ prompt: 'p', provider: model })));
    const result = await client.callTool({ name: 'support-bot', arguments: { message: 'hi' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('The agent failed');
  });

  it('returns a clear isError when the run pauses for approval', async () => {
    const paused = { text: '', finishReason: 'awaiting-approval', approvalId: 'a1', messages: [], toolCalls: [], steps: 1, usage: {} };
    const agent = { send: vi.fn().mockResolvedValue(paused) };
    const client = await connect(spec(agent as unknown as SimpleAgent));
    const result = await client.callTool({ name: 'support-bot', arguments: { message: 'wipe' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/needs human approval.*cannot be approved over MCP/s);
  });

  it('returns isError when a createAgent() agent pauses on an approval-gated tool (LOU-D21)', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'delete_all' }] }, 'done']);
    const agent = createAgent({ prompt: 'p', provider: model, tools: [deleteAll] });
    const client = await connect(spec(agent));
    const result = await client.callTool({ name: 'support-bot', arguments: { message: 'wipe' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/needs human approval.*cannot be approved over MCP/s);
  });

  it('does not leave the paused approvals of an MCP call pending, nor call the model again', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'delete_all', id: 'c1' }, { name: 'delete_all', id: 'c2' }] }]);
    const agent = createAgent({ prompt: 'p', provider: model, tools: [deleteAll] });
    const client = await connect(spec(agent));
    const result = await client.callTool({ name: 'support-bot', arguments: { message: 'wipe' } });
    expect(textOf(result)).toMatch(/needs human approval/);
    expect(await agent.approvals.list()).toEqual([]);
    expect(model.calls).toHaveLength(1);
  });

  it('reports an aborted run as an error', async () => {
    const agent = {
      send: vi.fn().mockResolvedValue({ text: '', finishReason: 'aborted', messages: [], toolCalls: [], steps: 0, usage: {} }),
    };
    const client = await connect(spec(agent as unknown as SimpleAgent));
    const result = await client.callTool({ name: 'support-bot', arguments: { message: 'hi' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('cancelled');
  });

  it('aborts the agent run when the MCP request is cancelled', async () => {
    let seen: AbortSignal | undefined;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const agent = {
      send: vi.fn((_message: string, options?: { signal?: AbortSignal }) => {
        seen = options?.signal;
        started();
        return new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () =>
            resolve({ text: '', finishReason: 'aborted', messages: [], toolCalls: [], steps: 0, usage: {} })
          );
        });
      }),
    };
    const client = await connect(spec(agent as unknown as SimpleAgent));
    const controller = new AbortController();
    const call = client.callTool(
      { name: 'support-bot', arguments: { message: 'slow' } },
      undefined,
      { signal: controller.signal }
    );
    await startedPromise;
    controller.abort();
    await expect(call).rejects.toBeDefined();
    await vi.waitFor(() => expect(seen?.aborted).toBe(true));
  });
});

describe('serveMcp direct tools', () => {
  const agent = createAgent({ prompt: 'p', provider: mockModel(['x']) });

  it('exposes tools with a JSON Schema derived from the zod input', async () => {
    const client = await connect(spec(agent, { tools: [searchDocs] }));
    const { tools } = await client.listTools();
    const found = tools.find((t) => t.name === 'search_docs');
    expect(found?.description).toBe('Search the docs');
    expect(found?.inputSchema).toMatchObject({ properties: { query: { type: 'string' } }, required: ['query'] });
  });

  it('runs a tool and validates its arguments', async () => {
    const client = await connect(spec(agent, { tools: [searchDocs] }));
    const ok = await client.callTool({ name: 'search_docs', arguments: { query: 'mcp' } });
    expect(textOf(ok)).toBe('results for mcp');
    const bad = await client.callTool({ name: 'search_docs', arguments: { query: 1 } });
    expect(bad.isError).toBe(true);
  });

  it('serializes non-string results as JSON', async () => {
    const objectTool = defineTool({ name: 'obj', description: 'd', input: z.object({}), execute: () => ({ a: 1 }) });
    const client = await connect(spec(agent, { tools: [objectTool] }));
    expect(textOf(await client.callTool({ name: 'obj', arguments: {} }))).toBe('{"a":1}');
  });

  it('maps a throwing tool to isError', async () => {
    const client = await connect(spec(agent, { tools: [brokenTool] }));
    const result = await client.callTool({ name: 'broken', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('boom');
  });

  it('hides needsApproval tools unless allowApprovalTools is set', async () => {
    const hidden = await connect(spec(agent, { tools: [searchDocs, deleteAll] }));
    expect((await hidden.listTools()).tools.map((t) => t.name).sort()).toEqual(['search_docs', 'support-bot']);

    const shown = await connect(spec(agent, { tools: [searchDocs, deleteAll], allowApprovalTools: true }));
    expect((await shown.listTools()).tools.map((t) => t.name)).toContain('delete_all');
    expect(textOf(await shown.callTool({ name: 'delete_all', arguments: {} }))).toBe('deleted');
  });
});

describe('serveMcp options', () => {
  const agent = createAgent({ prompt: 'p', provider: mockModel(['x']) });

  it('sanitizes the default tool name', () => {
    expect(sanitizeToolName('Support Bot!')).toBe('Support_Bot');
    expect(sanitizeToolName('!!!')).toBe('agent');
    expect(sanitizeToolName('x'.repeat(100))).toHaveLength(64);
  });

  it('validates options with fix-it messages', async () => {
    await expect(serveMcp({ agent: {} as SimpleAgent, name: 'a' })).rejects.toThrow(/createAgent/);
    await expect(serveMcp({ agent, name: '' })).rejects.toThrow(/`name` is required/);
    await expect(serveMcp({ agent, name: 'search_docs', tools: [searchDocs] })).rejects.toThrow(/two tools are named/);
    // defineTool itself now rejects a non-object root (Eve TOOLS-F10), so swap the schema in afterwards.
    const notObject = { ...defineTool({ name: 'str', description: 'd', input: z.object({}), execute: () => 'x' }), input: z.string() } as never;
    await expect(serveMcp({ agent, name: 'a', tools: [notObject] })).rejects.toThrow(/z\.object/);
  });

  it('warns when allowApprovalTools exposes a gated tool', async () => {
    const warn = vi.fn();
    const server = await serveMcp({
      agent,
      name: 'a',
      tools: [deleteAll],
      allowApprovalTools: true,
      transport: { type: 'http', port: 0 },
      warn,
    });
    closers.push(server.close);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WITHOUT a human gate'));
  });
});

describe('serveMcp over HTTP', () => {
  const agent = createAgent({ prompt: 'p', provider: mockModel(['pong'], { onExhausted: 'repeat-last' }) });

  async function start(options: Partial<Parameters<typeof serveMcp>[0]> & { auth?: boolean } = {}): Promise<ServeMcpHandle> {
    const server = await serveMcp({
      agent,
      name: 'support-bot',
      transport: { type: 'http', port: 0, ...(options.auth ? { auth: { type: 'bearer' as const, token: 's3cret' } } : {}) },
      warn: () => {},
    });
    closers.push(server.close);
    return server;
  }

  async function post(url: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  }

  it('completes a client round-trip on an ephemeral port bound to 127.0.0.1', async () => {
    const server = await start();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const client = new Client({ name: 'c', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url!)));
    closers.push(() => client.close());
    const result = await client.callTool({ name: 'support-bot', arguments: { message: 'ping' } });
    expect(textOf(result)).toBe('pong');
  });

  it('a client timeout (notifications/cancelled in another POST) aborts the agent run', async () => {
    let seen: AbortSignal | undefined;
    const slow = {
      send: vi.fn((_message: string, options?: { signal?: AbortSignal }) => {
        seen = options?.signal;
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ text: 'late', finishReason: 'stop', messages: [], toolCalls: [], steps: 0, usage: {} }), 5000);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve({ text: '', finishReason: 'aborted', messages: [], toolCalls: [], steps: 0, usage: {} });
          });
        });
      }),
    };
    const server = await serveMcp({ agent: slow as unknown as SimpleAgent, name: 'slow', transport: { type: 'http', port: 0 }, warn: () => {} });
    closers.push(server.close);
    const client = new Client({ name: 'c', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url!)));
    closers.push(() => client.close());
    await expect(client.callTool({ name: 'slow', arguments: { message: 'x' } }, undefined, { timeout: 200 })).rejects.toThrow(/timed out/i);
    await vi.waitFor(() => expect(seen?.aborted).toBe(true));
  });

  it('a cancel naming a request id two clients have in flight is ignored', async () => {
    const signals: AbortSignal[] = [];
    let started = 0;
    const slow = {
      send: vi.fn((_message: string, options?: { signal?: AbortSignal }) => {
        signals.push(options!.signal!);
        started += 1;
        return new Promise((resolve) => setTimeout(() => resolve({ text: 'done', finishReason: 'stop', messages: [], toolCalls: [], steps: 0, usage: {} }), 300));
      }),
    };
    const server = await serveMcp({ agent: slow as unknown as SimpleAgent, name: 'slow', transport: { type: 'http', port: 0 }, warn: () => {} });
    closers.push(server.close);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const call = () =>
      fetch(server.url!, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'slow', arguments: { message: 'x' } } }) });
    const calls = [call(), call()];
    await vi.waitFor(() => expect(started).toBe(2));
    await fetch(server.url!, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }) });
    const results = await Promise.all(calls.map(async (response) => (await response).json()));
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
    expect(results.map((result) => result.result.content[0].text)).toEqual(['done', 'done']);
  });

  /** An agent whose runs take `ms` unless aborted; `signals` holds each run's signal, in start order. */
  function slowAgent(ms: number) {
    const signals: AbortSignal[] = [];
    const agent = {
      send: vi.fn((_message: string, options?: { signal?: AbortSignal }) => {
        signals.push(options!.signal!);
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ text: 'done', finishReason: 'stop', messages: [], toolCalls: [], steps: 0, usage: {} }), ms);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve({ text: '', finishReason: 'aborted', messages: [], toolCalls: [], steps: 0, usage: {} });
          });
        });
      }),
    };
    return { agent: agent as unknown as SimpleAgent, signals };
  }

  it('hands out an Mcp-Session-Id on initialize, so a cancel from one of two identical clients stops only its own run', async () => {
    const { agent: slow, signals } = slowAgent(600);
    const server = await serveMcp({ agent: slow, name: 'slow', transport: { type: 'http', port: 0 }, warn: () => {} });
    closers.push(server.close);
    const clients = [new Client({ name: 'c', version: '1' }), new Client({ name: 'c', version: '1' })];
    const transports = clients.map(() => new StreamableHTTPClientTransport(new URL(server.url!)));
    for (const [i, client] of clients.entries()) {
      await client.connect(transports[i]);
      closers.push(() => client.close());
    }
    expect(transports[0].sessionId).toEqual(expect.any(String));
    expect(transports[0].sessionId).not.toBe(transports[1].sessionId);
    // Both clients send the same JSON-RPC ids, from the same address and User-Agent.
    const full = clients[0].callTool({ name: 'slow', arguments: { message: 'a' } });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    await expect(clients[1].callTool({ name: 'slow', arguments: { message: 'b' } }, undefined, { timeout: 100 })).rejects.toThrow(/timed out/i);
    await vi.waitFor(() => expect(signals[1]?.aborted).toBe(true));
    expect(textOf(await full)).toBe('done');
    expect(signals[0].aborted).toBe(false);
  });

  it("a late cancel from another session does not stop a request with the same id, and a cancelled request is answered", async () => {
    const { agent: slow, signals } = slowAgent(400);
    const server = await serveMcp({ agent: slow, name: 'slow', transport: { type: 'http', port: 0 }, warn: () => {} });
    closers.push(server.close);
    const headers = (session: string) => ({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': session });
    const call = (session: string) =>
      fetch(server.url!, { method: 'POST', headers: headers(session), body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'slow', arguments: { message: 'x' } } }) });
    const cancel = (session: string) =>
      fetch(server.url!, { method: 'POST', headers: headers(session), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }) });

    const a = call('session-a');
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    // session-b has nothing in flight under id 7: its (late) cancel must not reach session-a.
    await cancel('session-b');
    expect(signals[0].aborted).toBe(false);
    expect((await (await a).json()).result.content[0].text).toBe('done');

    const b = call('session-b');
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    await cancel('session-b');
    const answer = await b;
    expect(signals[1].aborted).toBe(true);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32800, message: 'Request cancelled' } });
  });

  it('rejects missing or wrong bearer tokens with 401 and accepts the right one', async () => {
    const server = await start({ auth: true });
    expect((await post(server.url!)).status).toBe(401);
    expect((await post(server.url!, { Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post(server.url!, { Authorization: 'Bearer s3cret' })).status).toBe(200);
  });

  it('answers 404 on other paths and 405 on non-POST', async () => {
    const server = await start();
    expect((await post(server.url!.replace('/mcp', '/other'))).status).toBe(404);
    expect((await fetch(server.url!)).status).toBe(405);
  });

  it('answers 400 on invalid JSON', async () => {
    const server = await start();
    const res = await fetch(server.url!, { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
  });

  /** A raw request with a forged Host header (fetch() does not let us set one). */
  function rawPost(port: number, headers: Record<string, string>): Promise<number> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        }
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  it('Eve TOOLS-F5: rejects a foreign Host or Origin on a loopback bind (DNS rebinding)', async () => {
    const server = await start();
    const port = server.port!;
    expect(await rawPost(port, { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` })).toBe(403);
    expect(await rawPost(port, { Host: `evil.example:${port}` })).toBe(403);
    // A name that merely starts with `127.` resolves wherever its owner wants.
    expect(await rawPost(port, { Host: `127.attacker.example:${port}` })).toBe(403);
    expect(await rawPost(port, { Host: `127.0.0.1.attacker.example:${port}` })).toBe(403);
    expect(await rawPost(port, { Host: `127.0.0.1:${port}`, Origin: 'http://evil.example' })).toBe(403);
    expect(await rawPost(port, { Host: `localhost:${port}`, Origin: `http://localhost:${port}` })).toBe(200);
    expect(await rawPost(port, { Host: `127.0.0.1:${port}` })).toBe(200);
  });

  it('Eve TOOLS-F5: allowedHosts replaces the loopback default and allowedOrigins adds origins', async () => {
    const server = await serveMcp({
      agent,
      name: 'a',
      transport: { type: 'http', port: 0, allowedHosts: ['mcp.internal'], allowedOrigins: ['https://app.example'] },
      warn: () => {},
    });
    closers.push(server.close);
    const port = server.port!;
    expect(await rawPost(port, { Host: `mcp.internal:${port}`, Origin: 'https://app.example' })).toBe(200);
    expect(await rawPost(port, { Host: `127.0.0.1:${port}` })).toBe(403);
    expect(await rawPost(port, { Host: `mcp.internal:${port}`, Origin: 'https://other.example' })).toBe(403);
  });

  it('warns once when bound to a non-loopback host without auth', async () => {
    const warn = vi.fn();
    const server = await serveMcp({ agent, name: 'a', transport: { type: 'http', port: 0, host: '0.0.0.0' }, warn });
    closers.push(server.close);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without authentication'));
  });

  it('does not warn on non-loopback hosts when auth is set, and rejects an empty token', async () => {
    const warn = vi.fn();
    const server = await serveMcp({
      agent,
      name: 'a',
      transport: { type: 'http', port: 0, host: '0.0.0.0', auth: { type: 'bearer', token: 't' } },
      warn,
    });
    closers.push(server.close);
    expect(warn).not.toHaveBeenCalled();
    await expect(
      serveMcp({ agent, name: 'a', transport: { type: 'http', port: 0, auth: { type: 'bearer', token: '' } } })
    ).rejects.toThrow(/token must be a non-empty string/);
  });
});
