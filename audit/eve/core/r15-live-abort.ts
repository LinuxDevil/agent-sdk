// CORE: live - abort latency against a real provider (send + stream break).
// Run: npx tsx eve/core/r15-live-abort.ts
import { createAgent } from '@lousho/build-ai-agent';
import { LIVE_MODEL } from '../../_shared/env.ts';
const agent = createAgent({ model: LIVE_MODEL, modelSettings: { maxTokens: 400 } });
let t0 = Date.now();
const r = await agent.send('Write a 300-word story about a lighthouse.', { signal: AbortSignal.timeout(400) });
console.log('send abort@400ms -> resolved in %dms finishReason=%s text.length=%d usage.out=%d', Date.now() - t0, r.finishReason, r.text.length, r.usage.outputTokens);
t0 = Date.now();
const run = agent.stream('Write a 300-word story about a lighthouse.');
let chars = 0;
for await (const e of run) { if (e.type === 'text.delta') { chars += e.text.length; if (chars > 50) break; } }
const sr = await run.result;
console.log('stream break after %d chars -> result in %dms finishReason=%s text=%j msgs=%j', chars, Date.now() - t0, sr.finishReason, sr.text.slice(0, 60), sr.messages.map((m) => m.role));
