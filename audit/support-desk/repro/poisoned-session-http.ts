import { sse, summarize, getJson } from '../client.js';
for (const msg of ['Hello?', 'Anyone there?']) {
  const r = await sse('/chat', { sessionId: 'smoke-1', input: msg }, 'tok-alice');
  console.log(r.status, '\n  ' + summarize(r.events));
}
console.log(JSON.stringify((await getJson('/chat/smoke-1', 'tok-alice')).json).slice(0, 300));
