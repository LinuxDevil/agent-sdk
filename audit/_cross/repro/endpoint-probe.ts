// Logs which OpenAI endpoint paths the SDK hits on an OpenAI-compatible server.
import http from 'node:http';
import { createAgent, OpenAIProvider } from '@lousho/build-ai-agent';
const hits: string[] = [];
const proxy = http.createServer((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  const up = http.request({ host: 'localhost', port: 1234, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode!, r.headers); r.pipe(res); });
  req.pipe(up);
}).listen(18234);
const agent = createAgent({ provider: new OpenAIProvider({ apiKey: 'x', baseURL: 'http://localhost:18234/v1', defaultModel: 'qwen3.5-9b-uncensored-hauhaucs-aggressive' }), instructions: 'Be terse.' });
const r = await agent.send('Say OK');
console.log('text:', r.text, '\nendpoints:', hits);
proxy.close();
