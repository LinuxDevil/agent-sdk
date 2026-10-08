/** Logs every request the SDK sends (size, item roles, max tokens) through the proxy. */
import { startProxy } from '../proxy.js';
const proxy = await startProxy({ port: 1240, mode: 'pass' });
process.env.LOCAL_LLM_BASE_URL = proxy.url;
const { triageAgent, TASK } = await import('../agent.js');
const agent = triageAgent({ quiet: !!process.env.QUIET });
try {
  const r = await agent.send(TASK);
  console.log('finish', r.finishReason, JSON.stringify(r.usage));
} catch (e) { console.log('ERR', (e as Error).message.slice(0, 200)); }
await proxy.close();
