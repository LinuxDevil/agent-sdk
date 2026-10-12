// providers.md:247
import { createOpenAI } from '@ai-sdk/openai';
import { createAgent, fromAiSdk } from '@lousho/build-ai-agent';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const agent = createAgent({
  provider: fromAiSdk(openai.chat('gpt-4o-mini'), { fileMediaTypes: ['application/pdf'] }),
  instructions: 'You are a helpful assistant.',
});
export {};
