import { createAgent, OpenAIProvider, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';
const MODEL = 'qwen3.5-9b-uncensored-hauhaucs-aggressive';
const BASE = 'http://localhost:1234/v1';

async function attempt(label: string, make: () => any) {
  const t0 = Date.now();
  try {
    const agent = make();
    const r = await agent.send('Reply with exactly: PONG');
    console.log(`[${label}] ok ${Date.now()-t0}ms text=${JSON.stringify(r.text?.slice(0,120))} usage=${JSON.stringify(r.usage)} cost=${JSON.stringify(r.cost)}`);
  } catch (e: any) {
    console.log(`[${label}] FAIL ${e?.name}: ${e?.message?.slice(0,400)} code=${e?.code}`);
  }
}

await attempt('A: model string + OPENAI_BASE_URL', () => {
  process.env.OPENAI_BASE_URL = BASE; process.env.OPENAI_API_KEY = 'lm-studio';
  return createAgent({ model: `openai/${MODEL}`, instructions: 'Be terse.' });
});
await attempt('B: OpenAIProvider baseURL', () =>
  createAgent({ provider: new OpenAIProvider({ apiKey: 'lm-studio', baseURL: BASE, defaultModel: MODEL }), instructions: 'Be terse.' }));

// tool calling
const add = defineTool({ name: 'add', description: 'Add two integers', input: z.object({ a: z.number(), b: z.number() }), execute: async ({ a, b }) => ({ sum: a + b }) });
await attempt('C: tool call', () => ({ send: (_: string) =>
  createAgent({ provider: new OpenAIProvider({ apiKey: 'lm-studio', baseURL: BASE, defaultModel: MODEL }), instructions: 'Use the add tool for arithmetic.', tools: [add] })
    .send('What is 1234 + 8766? Use the tool.') }));
