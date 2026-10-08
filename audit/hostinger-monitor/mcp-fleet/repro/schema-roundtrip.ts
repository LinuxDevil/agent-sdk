// MCP inputSchema (JSON Schema) -> zod -> JSON Schema sent to the model: what survives? (listTools only, no API call)
import { createAgent } from '@lousho/build-ai-agent';
import { connectMcp } from '@lousho/build-ai-agent/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const server = { command: 'npx', args: ['--package=hostinger-api-mcp@latest', 'hostinger-vps-mcp'], env: { HOSTINGER_API_TOKEN: 'not-needed-for-listing' } };
const raw = new Client({ name: 'p', version: '1' });
await raw.connect(new StdioClientTransport({ ...server, env: { ...(process.env as any), ...server.env }, stderr: 'pipe' }));
const original = Object.fromEntries((await raw.listTools()).tools.map((t) => [t.name, t.inputSchema]));
await raw.close();
const mcp = await connectMcp({ hostinger: { ...server, stderr: 'pipe' } as any });
// capture the real wire format: a throwaway HTTP endpoint records the request body
let sent: any[] = [];
const { createServer } = await import('node:http');
const http = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { sent = JSON.parse(b).tools ?? []; res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"stop"}}'); }); }).listen(0);
await new Promise((r) => http.once('listening', r));
const { OpenAIProvider } = await import('@lousho/build-ai-agent');
const provider = new OpenAIProvider({ apiKey: 'x', baseURL: `http://127.0.0.1:${(http.address() as any).port}/v1`, defaultModel: 'm' });
await createAgent({ provider, instructions: 'x', tools: mcp.tools }).send('hi').catch(() => {});
http.close();
await mcp.close();
for (const t of sent) {
  const name = (t.function?.name ?? t.name) as string;
  console.log(`\n${name}\n  original: ${JSON.stringify(original[name.replace('hostinger__', '')])}\n  sent    : ${JSON.stringify(t.function?.parameters ?? t.parameters ?? t.inputSchema)}`);
}
