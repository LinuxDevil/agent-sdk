/** What ai@7 streamText yields for reasoning with @ai-sdk/openai against LM Studio (raw parts, no lousho). */
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { LOCAL_BASE_URL, LOCAL_MODEL } from '../../_shared/local.js';
const openai = createOpenAI({ baseURL: LOCAL_BASE_URL, apiKey: 'lm-studio' });
const r = streamText({ model: openai.chat(LOCAL_MODEL), prompt: 'Is 17 prime? yes/no', maxOutputTokens: 600 });
const seen: Record<string, number> = {};
for await (const p of r.fullStream) { seen[p.type] = (seen[p.type] ?? 0) + 1; if (p.type === 'reasoning-delta' && seen[p.type] === 1) console.log('first reasoning-delta part:', JSON.stringify(p)); }
console.log(seen);
