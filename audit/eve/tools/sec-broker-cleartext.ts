/**
 * sec-broker-cleartext: the credential broker injects the rule's Authorization into
 * plain http:// absolute-form requests, to ANY port of the rule host. A sandboxed
 * `curl http://api.github.com/...` (HTTP_PROXY set) therefore sends the token in
 * cleartext. Local stand-in: rule host 'localhost' (allowPrivate) + plain-HTTP server.
 */
import http from 'node:http';
import { createCredentialBroker } from '@lousho/build-ai-agent';
const seen: string[] = [];
const upstream = http.createServer((req, res) => { seen.push(`plain-HTTP ${req.headers.host} authorization=${req.headers.authorization ? '<present: ' + String(req.headers.authorization).slice(0, 10) + '...>' : 'none'}`); res.end('ok'); });
await new Promise<void>((r) => upstream.listen(0, 'localhost', r));
const port = (upstream.address() as any).port;
const broker = await createCredentialBroker({ rules: { localhost: { authorization: 'Bearer ghp_SECRET' } }, allowPrivate: ['localhost'] });
const proxy = new URL(broker.url);
await new Promise<void>((resolve, reject) => {
  http.request({ host: proxy.hostname, port: proxy.port, path: `http://localhost:${port}/user`, method: 'GET' }, (res) => { console.log('proxy status', res.statusCode); res.resume(); res.on('end', resolve); }).on('error', reject).end();
});
console.log(seen);
await broker.close(); upstream.close();
