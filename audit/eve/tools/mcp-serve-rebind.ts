// Repro: serveMcp HTTP transport accepts any Host/Origin (no DNS-rebinding protection).
// Run: cd E:\agent-sdk\audit && npx tsx eve/tools/mcp-serve-rebind.ts
import http from 'node:http';
import { createAgent } from '@lousho/build-ai-agent';
import { serveMcp } from '@lousho/build-ai-agent/mcp';
import { mockModel } from '@lousho/build-ai-agent/testing';

const agent = createAgent({ provider: mockModel(['agent ran (side effects would happen here)']) });
const server = await serveMcp({ agent, name: 'local-bot', transport: { type: 'http', port: 0 } });
console.log('serving', server.url, '(default: loopback, no auth)');

const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'local-bot', arguments: { message: 'hi' } } });
const out = await new Promise<string>((resolve, reject) => {
  const req = http.request(
    {
      host: '127.0.0.1', port: server.port, path: '/mcp', method: 'POST',
      // What a browser sends after evil.example re-binds its DNS name to 127.0.0.1:
      headers: {
        Host: `evil.example:${server.port}`,
        Origin: `http://evil.example:${server.port}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve(`status ${res.statusCode}: ${s.slice(0, 200)}`));
    }
  );
  req.on('error', reject);
  req.end(body);
});
console.log('Host: evil.example / Origin: http://evil.example ->', out);
await server.close();
