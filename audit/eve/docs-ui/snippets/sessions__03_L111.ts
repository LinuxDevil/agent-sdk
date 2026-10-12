// sessions.md:111
import { createAgent } from '@lousho/build-ai-agent';

const chat = createAgent({ instructions: 'Be brief.', provider });
const session = chat.session();

for await (const event of session.stream('My name is Ali.')) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
// The turn is already saved: this call sees it.
const { text } = await session.send('What is my name?');
export {};
