// Offline: a fake OpenAI-compatible server that always answers LM Studio's context-overflow 500.
// How many HTTP requests does ONE agent.send() make? (OpenAIProvider instance, as the audit brief recommends)
import { createServer } from 'node:http';
import { createAgent, OpenAIProvider } from '@lousho/build-ai-agent';

let hits = 0;
const server = createServer((req, res) => {
  hits++;
  req.resume();
  req.on('end', () => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded.","type":"server_error"}' }));
  });
}).listen(0);
await new Promise((r) => server.once('listening', r));
const port = (server.address() as any).port;
const provider = () => new OpenAIProvider({ apiKey: 'x', baseURL: `http://127.0.0.1:${port}/v1`, defaultModel: 'm' });

let onRetryCalls = 0;
for (const [label, extra] of [['default', {}], ['retry: false', { retry: false }], ['retry: { maxRetries: 3, retryOn: () => true, backoff: 50ms }', { retry: { maxRetries: 3, retryOn: () => true, backoff: { initialDelayMs: 50, maxDelayMs: 50 }, onRetry: () => onRetryCalls++ } }]] as const) {
  onRetryCalls = 0;
  hits = 0;
  const t0 = Date.now();
  try {
    await createAgent({ provider: provider(), instructions: 'x', ...(extra as any) }).send('hi');
  } catch (e: any) {
    console.log(`[${label}] rejected after ${Date.now() - t0}ms with ${e.code}; HTTP requests made: ${hits}; onRetry calls: ${onRetryCalls}`);
  }
}
server.close();
