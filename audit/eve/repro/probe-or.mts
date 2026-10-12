import '../../_shared/env.ts';
import { createAgent } from '@lousho/build-ai-agent';
const agent = createAgent({ model: 'openrouter/openai/gpt-4o-mini' });
const r = await agent.send('Reply with exactly: pong');
console.log('finish:', r.finishReason, '| text:', JSON.stringify(r.text).slice(0, 80));
