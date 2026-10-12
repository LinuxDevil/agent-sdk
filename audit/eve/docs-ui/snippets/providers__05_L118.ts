// providers.md:118
import { createAgent, textOf, type Message } from '@lousho/build-ai-agent';

const agent = createAgent({ instructions: 'Describe images briefly.', model: 'openai/gpt-4o-mini' });
const messages: Message[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this picture?' },
      { type: 'image', image: 'https://example.com/cat.png' },
    ],
  },
];

const result = await agent.send(messages);
console.log(textOf(messages[0]), '->', result.text);
export {};
