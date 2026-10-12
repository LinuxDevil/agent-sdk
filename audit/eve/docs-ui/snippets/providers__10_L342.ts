// providers.md:342
import { createAgent, OpenAIProvider } from '@lousho/build-ai-agent';

const agent = createAgent({
  provider: new OpenAIProvider({
    name: 'openai',
    baseURL: 'http://localhost:1234/v1', // LM Studio
    apiKey: 'any', // local servers ignore the key, but one is required
    api: 'chat', // POST /v1/chat/completions
    defaultModel: 'qwen3-8b',
  }),
  compaction: { contextWindow: 8_192 }, // the window the model is loaded with
  instructions: 'You are a helpful assistant.',
});
export {};
