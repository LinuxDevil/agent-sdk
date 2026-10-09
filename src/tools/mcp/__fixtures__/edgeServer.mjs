// An MCP server over stdio for connect.test.ts (Eve TOOLS-F18): its tools/list
// has two pages, `grow` adds a tool and sends tools/list_changed, `die` exits
// the process with code 3. Plain JS, run with `node`.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const schema = { type: 'object', properties: {} };
const tool = (name) => ({ name, description: `The ${name} tool`, inputSchema: schema });
const pages = [[tool('grow'), tool('die')], [tool('page_two')]];

const server = new Server({ name: 'edge', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const page = Number(request.params?.cursor ?? 0);
  return { tools: pages[page], ...(page + 1 < pages.length && { nextCursor: String(page + 1) }) };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'die') {
    process.stderr.write('dying now\n');
    setTimeout(() => process.exit(3), 10);
    return { content: [{ type: 'text', text: 'bye' }] };
  }
  if (request.params.name === 'grow') {
    pages[pages.length - 1].push(tool('grown'));
    await server.sendToolListChanged();
    return { content: [{ type: 'text', text: 'grew' }] };
  }
  return { content: [{ type: 'text', text: request.params.name }] };
});

await server.connect(new StdioServerTransport());
