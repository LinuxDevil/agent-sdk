import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadMcpTools } from './McpToolLoader';
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
