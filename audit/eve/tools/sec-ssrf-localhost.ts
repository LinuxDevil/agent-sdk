/** sec-ssrf-localhost: does http_request reach a loopback server through a *name* (not a literal)? */
import http from 'node:http';
import { makeHttpRequest } from '@lousho/build-ai-agent/tools';
const hits: string[] = [];
const srv = http.createServer((req, res) => { hits.push(`${req.headers.host}${req.url}`); res.end('INTERNAL-SECRET'); });
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
const srv6 = http.createServer((req, res) => { hits.push(`v6 ${req.headers.host}${req.url}`); res.end('INTERNAL-SECRET6'); });
const port = (srv.address() as any).port;
await new Promise<void>((r) => srv6.listen(port, '::1', r)).catch(() => {});
for (const host of ['localhost', 'LOCALHOST.', 'localtest.me', '127.0.0.1.nip.io']) {
  const url = `http://${host}:${port}/probe`;
  try { const out = await makeHttpRequest({ url, method: 'GET', options: { timeout: 3000 } as any }); console.log('REACHED', url, '->', String(out).slice(0, 80)); }
  catch (e) { const err = e as any; console.log('error  ', url, '-', err.message, '| cause:', err.cause?.message ?? err.cause?.code ?? ''); }
}
console.log('server hits:', hits);
srv.close(); srv6.close();
