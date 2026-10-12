// providers.md:392
import { createOpenAI } from '@ai-sdk/openai';
import { createAgent, fromAiSdk } from '@lousho/build-ai-agent';

const local = createOpenAI({ baseURL: 'http://localhost:8080/v1', apiKey: 'any' });
const agent = createAgent({ provider: fromAiSdk(local.chat('qwen3-8b')), instructions: 'You are a helpful assistant.' });
export {};
