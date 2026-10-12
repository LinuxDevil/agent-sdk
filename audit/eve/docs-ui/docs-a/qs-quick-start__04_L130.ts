// quick-start.md:130
import { createAgent, createMockProvider } from '@lousho/build-ai-agent';

const agent = createAgent({
  prompt: 'You are a helpful assistant.',
  provider: createMockProvider({ responses: ['Nice to meet you, Ali.', 'Your name is Ali.'] }),
});

const session = agent.session();
await session.send('My name is Ali.');
const { text } = await session.send('What is my name?');

console.log(text);
console.log(session.messages.length); // 4: two user messages and two replies
export {};
