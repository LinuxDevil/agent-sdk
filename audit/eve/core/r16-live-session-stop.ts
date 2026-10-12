// CORE: live - user presses "Stop" mid-reply in a session: what does the transcript keep?
// Run: npx tsx eve/core/r16-live-session-stop.ts
import { createAgent, memoryStore } from '@lousho/build-ai-agent';
import { LIVE_MODEL } from '../../_shared/env.ts';
const agent = createAgent({ model: LIVE_MODEL, store: memoryStore(), modelSettings: { maxTokens: 400 } });
const session = agent.session({ id: 'stop-demo' });
const ac = new AbortController();
const run = session.stream('Write a 300-word story about a lighthouse keeper named Ola.', { signal: ac.signal });
let shown = '';
for await (const e of run) { if (e.type === 'text.delta') { shown += e.text; if (shown.length > 120) ac.abort(); } }
const r = await run.result;
console.log('user saw %d chars: %j', shown.length, shown.slice(0, 80));
console.log('result finishReason=%s text.length=%d usage.out=%d', r.finishReason, r.text.length, r.usage.outputTokens);
console.log('transcript roles: %j', (await session.load()).map((m) => `${m.role}:${String(m.content).length}`));
