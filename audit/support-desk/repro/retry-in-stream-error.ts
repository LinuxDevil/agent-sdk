/**
 * Repro: `retry: { maxRetries: 3 }` never retries the 500 that LM Studio reports
 * inside a 200 streaming response ("Context size has been exceeded."), because
 * withRetry() only retries until the stream's first chunk, and the AI SDK adapter
 * yields a non-content chunk before the error. A counting proxy sits between the
 * SDK and LM Studio so we see how many HTTP requests one send() makes.
 *
 *   npx tsx support-desk/repro/retry-in-stream-error.ts
 */
import { createAgent, OpenAIProvider } from '@lousho/build-ai-agent';
import { createServer, request as httpRequest } from 'node:http';
import { LOCAL_MODEL } from '../../_shared/local.js';

let requests = 0;
const proxy = createServer((req, res) => {
  requests++;
  const upstream = httpRequest({ host: 'localhost', port: 1234, path: req.url, method: req.method, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  req.pipe(upstream);
}).listen(4399);

const agent = createAgent({
  provider: new OpenAIProvider({ apiKey: 'lm-studio', baseURL: 'http://localhost:4399/v1', defaultModel: LOCAL_MODEL }),
  instructions: 'Be terse.',
  retry: { maxRetries: 3, backoff: { initialMs: 200 } },
});
for (let i = 0; i < 4; i++) {
  const before = requests;
  const retries: string[] = [];
  const run = agent.stream('A customer says the shoes do not fit. Reply in one sentence.');
  for await (const e of run) {
    if (e.type === 'provider.retry') retries.push(`attempt ${e.attempt}`);
    if (e.type === 'run.done') console.log(`send #${i}: finishReason=${e.finishReason} http requests=${requests - before} provider.retry events=${retries.length} text=${JSON.stringify(e.text.slice(0, 50))}`);
    if (e.type === 'error') console.log(`   error: ${e.error.message.slice(0, 110)}`);
  }
  await run.result.catch(() => {});
}
proxy.close();
