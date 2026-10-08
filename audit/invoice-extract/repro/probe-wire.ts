// Probe: what does createAgent({ output }) put on the wire to an OpenAI-compatible server?
import { createAgent, OpenAIProvider } from '@lousho/build-ai-agent';
import { z } from 'zod';
import { startProxy, summarize } from './proxy.js';
import { LOCAL_MODEL } from '../../_shared/local.js';

const proxy = await startProxy(1239, { keepResponses: true });
const provider = new OpenAIProvider({ apiKey: 'lm-studio', baseURL: proxy.url, defaultModel: LOCAL_MODEL });
const agent = createAgent({ provider, instructions: 'Extract data.', output: z.object({ vendor: z.string(), total: z.number() }) });
const t0 = Date.now();
const r = await agent.send('Invoice from ACME GmbH, total due EUR 1.234,50');
console.log('ms', Date.now() - t0, 'finish', r.finishReason, 'object', r.object, 'text', JSON.stringify(r.text).slice(0, 300));
console.log('usage', JSON.stringify(r.usage));
for (const e of proxy.log) {
  console.log('PATH', e.path, 'STATUS', e.status);
  console.log(JSON.stringify(summarize(e.body), null, 1).slice(0, 2500));
  console.log('RESP', e.responseText?.slice(0, 1200));
}
console.log('keys of result:', Object.keys(r));
proxy.close();
