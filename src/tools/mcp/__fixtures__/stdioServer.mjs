// A tiny MCP server over stdio for connect.test.ts (LOU-Z4). Plain JS, run with `node`.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync } from 'node:fs';

// FIXTURE_START_LOG: one line per start, for the reconnect test.
if (process.env.FIXTURE_START_LOG) appendFileSync(process.env.FIXTURE_START_LOG, 'start\n');

const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echoes text, prefixed with FIXTURE_PREFIX',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      annotations: { title: 'Echo', readOnlyHint: true },
    },
    {
      name: 'wipe',
      description: 'Pretends to delete everything (LOU-Z5: destructiveHint, so it asks for approval)',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      annotations: { destructiveHint: true },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // FIXTURE_DELAY_MS: a slow server, for the call timeout test.
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FIXTURE_DELAY_MS ?? 0)));
  return {
  content: [
    {
      type: 'text',
      text:
        request.params.name === 'wipe'
          ? `wiped ${request.params.arguments?.path}`
          : `${process.env.FIXTURE_PREFIX ?? ''}${request.params.arguments?.text}`,
    },
  ],
  };
});

await server.connect(new StdioServerTransport());
