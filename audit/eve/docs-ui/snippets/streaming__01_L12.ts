// streaming.md:12
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });

for await (const event of agent.stream('Weather in Paris?')) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
export {};
