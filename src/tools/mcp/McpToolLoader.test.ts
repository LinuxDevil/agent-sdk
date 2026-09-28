import { describe, it, expect } from 'vitest';
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
