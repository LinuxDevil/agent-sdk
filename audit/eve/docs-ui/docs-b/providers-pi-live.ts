// docs/providers.md:20,295-305 - pi/openrouter/... reads OPENROUTER_API_KEY.
import { createAgent } from '@lousho/build-ai-agent';
import { hasLiveKey } from '../../../_shared/env.ts';
if (!hasLiveKey) process.exit(0);
try {
  const r = await createAgent({ model: 'pi/openrouter/openai/gpt-4o-mini', retry: false }).send('Reply with the word pong.');
  console.log('pi live:', r.finishReason, JSON.stringify(r.text).slice(0, 80));
} catch (e: any) { console.log('pi live ->', e.name, e.code, String(e.message).split('\n')[0].slice(0, 200)); }
