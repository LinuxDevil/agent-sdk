import http from 'node:http';
import { createAgent, createWebFetchTool, createHttpTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
let hits = 0;
const srv = http.createServer((_q, s) => { hits++; s.end('INTERNAL-SECRET'); });
await new Promise<void>((r) => srv.listen(0, '::', () => r()));
const port = (srv.address() as any).port;
const call = async (tool: any, name: string, args: any) => { const m = mockModel([{ toolCalls: [{ name, args }] }, 'k']); const r = await createAgent({ provider: m, tools: [tool] }).send('x'); return String(r.messages.find((x: any) => x.role === 'tool')?.content).slice(0, 220); };
for (const host of ['localhost', '127.0.0.1', '[::1]', 'LOCALHOST.', '0.0.0.0', '127.1', '2130706433', '[::ffff:127.0.0.1]']) {
  console.log('web_fetch', host, '->', await call(createWebFetchTool({}), 'web_fetch', { url: `http://${host}:${port}/` }));
}
console.log('http_request localhost ->', await call(createHttpTool({} as any), 'http_request', { url: `http://localhost:${port}/`, method: 'GET' }));
console.log('server hits:', hits);
srv.close();
