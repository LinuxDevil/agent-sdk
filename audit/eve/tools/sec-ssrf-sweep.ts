/** sec-ssrf-sweep: literal/encoded loopback & private forms through the shipped http_request tool. */
import { makeHttpRequest } from '@lousho/build-ai-agent/tools';
const urls = [
  'http://127.0.0.1:9/', 'http://2130706433:9/', 'http://0x7f000001:9/', 'http://017700000001:9/', 'http://127.1:9/',
  'http://0.0.0.0:9/', 'http://[::1]:9/', 'http://[::ffff:127.0.0.1]:9/', 'http://[0:0:0:0:0:ffff:7f00:1]:9/',
  'http://[::]:9/', 'http://169.254.169.254/latest/meta-data/', 'http://[fd00::1]:9/', 'http://[fe80::1]:9/',
  'http://[64:ff9b::7f00:1]:9/', 'http://[2002:7f00:1::]:9/', 'http://localhost:9/', 'http://LOCALHOST.:9/',
  'http://localtest.me:9/', 'http://127.0.0.1.nip.io:9/', 'http://[::127.0.0.1]:9/', 'http://[::ffff:0:7f00:1]:9/',
];
for (const url of urls) {
  try { await makeHttpRequest({ url, method: 'GET', options: { timeout: 1500 } as any }); console.log('ALLOWED ', url); }
  catch (e) { console.log(/SSRF|blocked/i.test((e as Error).message) ? 'blocked ' : 'other   ', url, '-', (e as Error).message.slice(0, 80)); }
}
