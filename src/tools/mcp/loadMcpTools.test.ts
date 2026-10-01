import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadMcpTools, type McpApproval } from './McpToolLoader';
import { createConnectedClient } from './McpToolLoader.test';

describe('loadMcpTools', () => {
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
    const result = await descriptors['myconn__add'].tool.execute!({ a: 2, b: 3 }, {} as any);

    expect(callToolSpy).toHaveBeenCalledWith({ name: 'add', arguments: { a: 2, b: 3 } });
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

  it('a function gets the bare name and the annotations ({} when absent)', async () => {
    const seen: unknown[] = [];
    const result = await asks((tool) => {
      seen.push(tool);
      return tool.name.startsWith('destr');
    });
    expect(result.destructive).toBe(true);
    expect(result.plain).toBe(false);
    expect(seen).toContainEqual({ name: 'plain', annotations: {} });
    expect(seen).toContainEqual({ name: 'read_only', annotations: { readOnlyHint: true } });
  });

  it('keeps the raw annotations in metadata.mcp and uses the title as displayName', async () => {
    const loaded = await loadMcpTools(client, 's');
    expect(loaded.s__titled.metadata).toEqual({ mcp: { annotations: { title: 'Nice Title', readOnlyHint: true } } });
    expect(loaded.s__titled.displayName).toBe('Nice Title');
    expect(loaded.s__plain.metadata?.mcp?.annotations).toBeUndefined();
    expect(loaded.s__read_only.displayName).toBe('read_only');
  });
});
