// Same trivial request through OpenAIProvider (Responses API) and fromAiSdk(openai.chat()) (Chat Completions), against LM Studio.
import { createAgent, fromAiSdk } from '@lousho/build-ai-agent';
import { createOpenAI } from '@ai-sdk/openai';
import { localProvider, LOCAL_BASE_URL, LOCAL_MODEL } from '../../_shared/local.js';
const chat = fromAiSdk(createOpenAI({ apiKey: 'lm-studio', baseURL: LOCAL_BASE_URL }).chat(LOCAL_MODEL));
for (const [label, provider] of [['OpenAIProvider (responses)', localProvider()], ['fromAiSdk(openai.chat)', chat]] as const) {
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    try {
      const r = await createAgent({ provider: provider as never, instructions: 'Be terse.' }).send('A customer says the shoes do not fit. Reply in one sentence.');
      console.log(label, `#${i}`, Date.now() - t0, 'ms ok tokens', r.usage?.totalTokens, JSON.stringify(r.text.slice(0, 60)));
    } catch (e) {
      console.log(label, `#${i}`, Date.now() - t0, 'ms FAILED', (e as Error).message.slice(0, 100));
    }
  }
}
