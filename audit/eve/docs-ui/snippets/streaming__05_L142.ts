// streaming.md:142
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });
const session = agent.session({ id: 'user-42' });

for await (const event of session.stream('My name is Ali.')) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
const again = session.stream('What is my name?'); // streams with the first turn in its history
console.log((await again.result).text);
export {};
