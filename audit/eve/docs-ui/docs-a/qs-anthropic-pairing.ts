// Repro: @ai-sdk/anthropic@1 (ai-4 era) resolvable while ai@7 is installed (here it resolves from a parent node_modules).
import { createAgent } from '@lousho/build-ai-agent';
for (const k of ['OPENAI_API_KEY','OPENROUTER_API_KEY','OLLAMA_BASE_URL','LOUSHO_MODEL']) delete process.env[k];
process.env.ANTHROPIC_API_KEY = 'sk-ant-dummy';
const r = await createAgent({ model: 'anthropic/claude-3-5-haiku-latest' }).send('hi').catch((e: any) => e);
console.log(r?.constructor?.name, r?.name, r?.code, '|', String(r?.message).slice(0, 250));
