// providers.md:176
import { AgentBuilder, AgentExecutor } from '@lousho/build-ai-agent/executor';
import { resolveProvider, type Message } from '@lousho/build-ai-agent';

const agent = AgentBuilder.create().setName('vision').setPrompt('Describe images briefly.').build();
const input: Message[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this picture?' },
      { type: 'image', image: 'https://example.com/cat.png' },
    ],
  },
];

const result = await AgentExecutor.execute({ agent, input, provider: resolveProvider('openai/gpt-4o-mini') });
console.log(result.text);
export {};
