import { describe, it, expect, vi } from 'vitest';
import type { ToolExecutionOptions } from 'ai';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadMcpTools, type McpApproval } from './McpToolLoader';
import { createConnectedClient } from './McpToolLoader.test';

describe('loadMcpTools', () => {
  it('N2: deferLoading marks every loaded tool; the server name is kept in metadata.mcp.server', async () => {
    const { client } = await createConnectedClient();
    const deferred = await loadMcpTools(client, 'myconn', { deferLoading: true });
    expect(Object.values(deferred).map((descriptor) => descriptor.deferLoading)).toEqual([true, true]);
    expect(Object.values(deferred).map((descriptor) => descriptor.metadata?.mcp?.server)).toEqual(['myconn', 'myconn']);
    const plain = await loadMcpTools(client, 'myconn');
    expect(Object.values(plain).some((descriptor) => descriptor.deferLoading)).toBe(false);
  });

  it('synthesizes exactly 2 ToolDescriptors named <connectionName>__<toolName>', async () => {
    const { client } = await createConnectedClient();
    const descriptors = await loadMcpTools(client, 'myconn');

    expect(Object.keys(descriptors).sort()).toEqual(['myconn__add', 'myconn__search']);
    expect(descriptors['myconn__add'].tool).toBeDefined();
    expect(descriptors['myconn__search'].tool).toBeDefined();
  });

  it("calling a synthesized descriptor's execute invokes client.callTool with correct name/args and surfaces the return value", async () => {
    const { client } = await createConnectedClient();
    const callToolSpy = vi.spyOn(client, 'callTool');

    const descriptors = await loadMcpTools(client, 'myconn');
    const result = await descriptors['myconn__add'].tool.execute!({ a: 2, b: 3 }, {} as ToolExecutionOptions);

    expect(callToolSpy).toHaveBeenCalledWith({ name: 'add', arguments: { a: 2, b: 3 } }, undefined, {});
    expect(result).toMatchObject({ content: [{ type: 'text', text: '5' }] });
  });

  it('skips a tool whose schema cannot be converted, warns, reports it and loads the rest', async () => {
    const badTool = {
      name: 'broken',
      get inputSchema(): never {
        throw new Error('boom');
      },
    };
    const goodTool = {
      name: 'fine',
      description: 'ok',
      inputSchema: { type: 'object', properties: { a: { $ref: '#/$defs/A' } }, $defs: { A: { anyOf: [{ type: 'string' }, { type: 'null' }] } } },
    };
    const client = {
      listTools: async () => ({ tools: [badTool, goodTool] }),
    } as unknown as Client;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const onSkip = vi.fn();

    const descriptors = await loadMcpTools(client, 'srv', { logger, onSkip });

    expect(Object.keys(descriptors)).toEqual(['srv__fine']);
    expect(onSkip).toHaveBeenCalledWith({ name: 'broken', reason: 'boom' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = logger.warn.mock.calls[0][0] as string;
    expect(message).toContain('srv');
    expect(message).toContain('broken');
    expect(message).toContain('boom');
  });

  it('loads a tool whose schema uses anyOf and $ref instead of failing the whole server', async () => {
    const client = {
      listTools: async () => ({
        tools: [
          {
            name: 'create',
            inputSchema: {
              type: 'object',
              properties: { labels: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] } },
            },
          },
        ],
      }),
    } as unknown as Client;
    const descriptors = await loadMcpTools(client, 'srv');
    expect(Object.keys(descriptors)).toEqual(['srv__create']);
  });

  it('produces distinctly-named descriptors with zero collision across two connections exposing a tool of the same name', async () => {
    const { client: linearClient } = await createConnectedClient();
    const { client: githubClient } = await createConnectedClient();

    const linearDescriptors = await loadMcpTools(linearClient, 'linear');
    const githubDescriptors = await loadMcpTools(githubClient, 'github');

    expect(linearDescriptors['linear__search']).toBeDefined();
    expect(githubDescriptors['github__search']).toBeDefined();
    expect(linearDescriptors['github__search']).toBeUndefined();
    expect(githubDescriptors['linear__search']).toBeUndefined();
  });
});

describe('loadMcpTools approval (LOU-Z5)', () => {
  const schema = { type: 'object', properties: {} };
  const tools = [
    { name: 'plain', inputSchema: schema },
    { name: 'read_only', inputSchema: schema, annotations: { readOnlyHint: true } },
    { name: 'read_only_destructive', inputSchema: schema, annotations: { readOnlyHint: true, destructiveHint: true } },
    { name: 'destructive', inputSchema: schema, annotations: { destructiveHint: true } },
    { name: 'not_destructive', inputSchema: schema, annotations: { destructiveHint: false } },
    { name: 'writes', inputSchema: schema, annotations: { readOnlyHint: false } },
    { name: 'hints_only', inputSchema: schema, annotations: { idempotentHint: true, openWorldHint: true } },
    {
      name: 'titled',
      description: 'Long description',
      inputSchema: schema,
      annotations: { title: 'Nice Title', readOnlyHint: true },
    },
  ];
  const client = { listTools: async () => ({ tools }) } as unknown as Client;
  const asks = async (approval?: McpApproval) => {
    const loaded = await loadMcpTools(client, 's', approval === undefined ? {} : { approval });
    return Object.fromEntries(Object.entries(loaded).map(([name, d]) => [name.slice(3), d.needsApproval]));
  };

  it("'annotations' (the default): readOnlyHint runs; destructiveHint true or absent asks; destructiveHint false runs", async () => {
    const expected = {
      plain: true,
      read_only: false,
      read_only_destructive: false,
      destructive: true,
      not_destructive: false,
      writes: true,
      hints_only: true,
      titled: false,
    };
    expect(await asks()).toEqual(expected);
    expect(await asks('annotations')).toEqual(expected);
  });

  it("'always' asks for every tool and 'never' for none", async () => {
    expect(Object.values(await asks('always')).every((v) => v === true)).toBe(true);
    expect(Object.values(await asks('never')).every((v) => v === false)).toBe(true);
  });

  it('a function gets the bare name, the annotations ({} when absent) and the args, per call', async () => {
    const seen: unknown[] = [];
    const result = await asks((tool) => {
      seen.push(tool);
      return tool.name.startsWith('destr');
    });
    const decide = (name: string) => (result[name] as (args: unknown) => boolean)({ x: 1 });
    expect(decide('destructive')).toBe(true);
    expect(decide('plain')).toBe(false);
    decide('read_only');
    expect(seen).toContainEqual({ name: 'plain', annotations: {}, args: { x: 1 } });
    expect(seen).toContainEqual({ name: 'read_only', annotations: { readOnlyHint: true }, args: { x: 1 } });
  });

  it('keeps the raw annotations in metadata.mcp and uses the title as displayName', async () => {
    const loaded = await loadMcpTools(client, 's');
    expect(loaded.s__titled.metadata).toEqual({ mcp: { annotations: { title: 'Nice Title', readOnlyHint: true }, server: 's', tool: 'titled' } });
    expect(loaded.s__titled.displayName).toBe('Nice Title');
    expect(loaded.s__plain.metadata?.mcp?.annotations).toBeUndefined();
    expect(loaded.s__read_only.displayName).toBe('read_only');
  });
});

describe('loadMcpTools call options (audit D4)', () => {
  /** A connected client whose `slow` tool never answers on its own. */
  async function hangingClient(): Promise<Client> {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
    const server = new McpServer({ name: 'slow', version: '1.0.0' });
    server.registerTool('slow', { description: 'Never answers' }, () => new Promise<never>(() => {}));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new McpClient({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("forwards the run's abort signal to callTool, so an abort ends the call at once", async () => {
    const tools = await loadMcpTools(await hangingClient(), 's');
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(new Error('run aborted')), 30);
    await expect(tools.s__slow.execute!({}, { toolCallId: 'c1', messages: [], abortSignal: controller.signal } as never)).rejects.toThrow(
      /run aborted/
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('timeoutMs bounds each call', async () => {
    const tools = await loadMcpTools(await hangingClient(), 's', { timeoutMs: 50 });
    await expect(tools.s__slow.execute!({}, { toolCallId: 'c1', messages: [] } as never)).rejects.toThrow(/timed out/i);
  });
});

describe('loadMcpTools tool names (audit D4)', () => {
  const schema = { type: 'object', properties: {} };
  const named = (...names: string[]) => {
    const callTool = vi.fn(async (params: { name: string }) => ({ content: [{ type: 'text', text: `ran ${params.name}` }] }));
    return { client: { listTools: async () => ({ tools: names.map((name) => ({ name, inputSchema: schema })) }), callTool } as unknown as Client, callTool };
  };
  const valid = /^[a-zA-Z0-9_-]{1,64}$/;

  it('sanitizes names to the provider-safe charset and length, and calls the server with the original name', async () => {
    const long = 'x'.repeat(70);
    const { client, callTool } = named('vps.list', 'get metrics', 'ns/tool', long, 'execute');
    const tools = await loadMcpTools(client, 'hostinger.vps');
    const keys = Object.keys(tools);
    expect(keys.slice(0, 3)).toEqual(['hostinger_vps__vps_list', 'hostinger_vps__get_metrics', 'hostinger_vps__ns_tool']);
    expect(keys.every((key) => valid.test(key))).toBe(true);
    expect(keys.every((key) => tools[key].name === key)).toBe(true);
    expect(tools.hostinger_vps__vps_list.metadata?.mcp).toMatchObject({ server: 'hostinger.vps', tool: 'vps.list' });
    const longKey = keys[3];
    expect(longKey).toHaveLength(64);
    await tools[longKey].execute!({}, { toolCallId: 'c1', messages: [] } as never);
    expect(callTool).toHaveBeenLastCalledWith({ name: long, arguments: {} }, undefined, {});
  });

  it('keeps names that are already valid unchanged', async () => {
    const tools = await loadMcpTools(named('search', 'multi-execute').client, 'srv');
    expect(Object.keys(tools)).toEqual(['srv__search', 'srv__multi-execute']);
  });

  it('gives names that collide after sanitizing distinct keys', async () => {
    const { client, callTool } = named('a.b', 'a/b', 'a_b');
    const tools = await loadMcpTools(client, 'srv');
    const keys = Object.keys(tools);
    expect(new Set(keys).size).toBe(3);
    expect(keys.every((key) => valid.test(key))).toBe(true);
    for (const key of keys) await tools[key].execute!({}, { toolCallId: 'c', messages: [] } as never);
    expect(callTool.mock.calls.map(([params]) => params.name).sort()).toEqual(['a.b', 'a/b', 'a_b']);
  });
});

describe('loadMcpTools include / exclude (audit D4)', () => {
  const schema = { type: 'object', properties: {} };
  const client = {
    listTools: async () => ({ tools: ['search', 'execute', 'multi-execute'].map((name) => ({ name, inputSchema: schema })) }),
  } as unknown as Client;

  it('include keeps only the listed tools; exclude drops the listed ones', async () => {
    expect(Object.keys(await loadMcpTools(client, 's', { tools: { include: ['search', 'execute'] } }))).toEqual(['s__search', 's__execute']);
    expect(Object.keys(await loadMcpTools(client, 's', { tools: { exclude: ['multi-execute'] } }))).toEqual(['s__search', 's__execute']);
    expect(Object.keys(await loadMcpTools(client, 's', { tools: { include: ['search', 'execute'], exclude: ['execute'] } }))).toEqual(['s__search']);
  });

  it('warns about an include name the server does not have', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await loadMcpTools(client, 's', { logger, tools: { include: ['search', 'serch'] } });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("'serch'"), expect.objectContaining({ server: 's', tool: 'serch' }));
  });
});

describe('loadMcpTools approval predicate sees the arguments (audit D4)', () => {
  const client = {
    listTools: async () => ({
      tools: [{ name: 'execute', inputSchema: { type: 'object', properties: { operation: { type: 'string' } } }, annotations: { readOnlyHint: true } }],
    }),
  } as unknown as Client;

  it('passes each call\'s arguments to an approval function', async () => {
    const approval = vi.fn((tool: { name: string; args?: Record<string, unknown> }) => !String(tool.args?.operation).startsWith('GET'));
    const tools = await loadMcpTools(client, 's', { approval });
    const check = tools.s__execute.needsApproval as (args: unknown, ctx: unknown) => unknown;
    expect(typeof check).toBe('function');
    expect(await check({ operation: 'GET /vms' }, {})).toBe(false);
    expect(await check({ operation: 'POST /vms/1/restart' }, {})).toBe(true);
    expect(approval).toHaveBeenLastCalledWith({ name: 'execute', annotations: { readOnlyHint: true }, args: { operation: 'POST /vms/1/restart' } });
  });
});
