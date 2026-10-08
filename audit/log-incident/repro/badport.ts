/** What does a consumer see when LM Studio is not running? */
import { createAgent, OpenAIProvider } from '@lousho/build-ai-agent';
const agent = createAgent({ provider: new OpenAIProvider({ apiKey: 'x', baseURL: 'http://localhost:1299/v1', defaultModel: 'm', maxRetries: 0 }), retry: { maxRetries: 0 } });
try { await agent.send('hi'); } catch (e: any) {
  console.log('name:', e.name, '| code:', e.code, '| message:', JSON.stringify(e.message));
  console.log('compacted:', JSON.stringify(e.compacted));
  let c = e.cause, d = 1;
  while (c && d < 6) { console.log(`cause[${d}]:`, c.name, JSON.stringify(c.message), c.code ?? '', c.statusCode ?? ''); c = c.cause; d++; }
}
