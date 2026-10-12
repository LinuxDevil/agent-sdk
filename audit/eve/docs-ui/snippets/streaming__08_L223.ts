// streaming.md:223
import { createAgent } from '@lousho/build-ai-agent';

const researcher = createAgent({ provider, instructions: 'You research.', description: 'Finds sources' });
const lead = createAgent({ provider, instructions: 'You coordinate.', subagents: { researcher } });

for await (const event of lead.stream('Write about bicycles')) {
  const who = event.subagent ? `[${event.subagent.name}] ` : '';
  if (event.type === 'text.delta') process.stdout.write(who + event.text);
}
export {};
