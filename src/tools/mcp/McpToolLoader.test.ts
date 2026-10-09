import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { listRemoteTools } from './McpToolLoader';

/**
 * Stands up a tiny in-process MCP server exposing two dummy tools, and
 * returns a connected Client talking to it over InMemoryTransport.
 */
export async function createConnectedClient(): Promise<{ client: Client; server: McpServer }> {
  const server = new McpServer({ name: 'test-server', version: '1.0.0' });

  server.registerTool(
    'add',
    {
      description: 'Add two numbers',
      inputSchema: { a: z.number(), b: z.number() },
    },
    async ({ a, b }: { a: number; b: number }) => ({
      content: [{ type: 'text' as const, text: String(a + b) }],
    })
  );

  server.registerTool(
    'search',
    {
      description: 'Search for something',
      inputSchema: { query: z.string() },
    },
    async ({ query }: { query: string }) => ({
      content: [{ type: 'text' as const, text: `results for ${query}` }],
    })
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, server };
}

describe('listRemoteTools', () => {
  it('returns exactly the tools the mock server exposes', async () => {
    const { client } = await createConnectedClient();
    const tools = await listRemoteTools(client);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(['add', 'search']);
  });

  it('rejects rather than resolving when the client is not connected', async () => {
    const disconnectedClient = new Client({ name: 'disconnected-client', version: '1.0.0' });
    await expect(listRemoteTools(disconnectedClient)).rejects.toBeTruthy();
  });
});

describe('listRemoteTools pagination (Eve TOOLS-F18)', () => {
  const tool = (name: string) => ({ name, inputSchema: { type: 'object' } });
  const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it('follows nextCursor through every page', async () => {
    const pages: Record<string, { tools: ReturnType<typeof tool>[]; nextCursor?: string }> = {
      start: { tools: [tool('a')], nextCursor: 'p2' },
      p2: { tools: [tool('b')], nextCursor: 'p3' },
      p3: { tools: [tool('c')] },
    };
    const client = { listTools: async (params?: { cursor?: string }) => pages[params?.cursor ?? 'start'], callTool: async () => ({}) };
    expect((await listRemoteTools(client)).map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('stops with a warning on a repeated cursor', async () => {
    const log = logger();
    const client = { listTools: async () => ({ tools: [tool('a')], nextCursor: 'same' }), callTool: async () => ({}) };
    expect(await listRemoteTools(client, { logger: log, server: 's' })).toHaveLength(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("repeated the cursor 'same'"), expect.anything());
  });

  it('stops with a warning after 100 pages', async () => {
    const log = logger();
    let n = 0;
    const client = { listTools: async () => ({ tools: [tool(`t${n}`)], nextCursor: String(++n) }), callTool: async () => ({}) };
    expect(await listRemoteTools(client, { logger: log })).toHaveLength(100);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('more than 100 pages'), expect.anything());
  });
});
