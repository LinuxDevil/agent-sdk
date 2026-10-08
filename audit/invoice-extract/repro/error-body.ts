// Repro (stub server, no model): LM Studio's Chat Completions errors are `{"error":"<string>"}`. What reaches the caller?
import http from 'node:http';
import { createAgent, fromAiSdk, OpenAIProvider } from '@lousho/build-ai-agent';
import { createOpenAI } from '@ai-sdk/openai';

const BODY_CHAT = JSON.stringify({ error: 'Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded.","type":"server_error"}' });
const BODY_RESP = JSON.stringify({ error: { message: 'Engine protocol predict stream returned an error: Context size has been exceeded.', type: 'internal_error', param: null, code: 'unknown' } });
let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  req.resume();
  req.on('end', () => {
    if (req.url?.includes('chat/completions')) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(BODY_CHAT); }
    else { res.writeHead(500, { 'content-type': 'application/json' }); res.end(BODY_RESP); }
  });
});
await new Promise<void>((r) => server.listen(1251, r));
const base = 'http://localhost:1251/v1';

for (const [label, provider] of [
  ['chat (400, error is a string)', fromAiSdk(createOpenAI({ apiKey: 'x', baseURL: base }).chat('m'))],
  ['responses (500, error is an object)', new OpenAIProvider({ apiKey: 'x', baseURL: base, defaultModel: 'm', maxRetries: 0 })],
] as const) {
  hits = 0;
  try {
    await createAgent({ provider, retry: { maxRetries: 1, backoff: { initialMs: 10 } } }).send('hi');
  } catch (e: any) {
    console.log(`[${label}] ${e.constructor.name} code=${e.code} status=${e.statusCode}`);
    console.log('   message:', JSON.stringify(e.message));
    console.log('   detail :', JSON.stringify(e.detail));
    console.log('   compacted:', JSON.stringify(e.compacted));
    console.log('   cause.responseBody present:', typeof e.cause?.responseBody === 'string', ' http calls made:', hits);
  }
}
server.close();
