// Raw MCP client: dumps tool input schemas and runs the READ-ONLY `search` tool.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readHostingerToken } from '../token.js';
const token = readHostingerToken();
const client = new Client({ name: 'probe', version: '1' });
const transport = new StdioClientTransport({ command: 'npx', args: ['--package=hostinger-api-mcp@latest', 'hostinger-vps-mcp'], env: { ...process.env as any, HOSTINGER_API_TOKEN: token }, stderr: 'pipe' });
await client.connect(transport);
const { tools } = await client.listTools();
for (const t of tools) console.log(t.name, '\n  desc:', t.description?.slice(0, 600), '\n  schema:', JSON.stringify(t.inputSchema));
const q = process.argv[2] ?? 'virtual machine';
const r: any = await client.callTool({ name: 'search', arguments: { query: q } });
console.log('SEARCH RESULT (chars):', JSON.stringify(r).length);
console.log(JSON.stringify(r).replaceAll(token, '[REDACTED]').slice(0, 6000));
await client.close();
