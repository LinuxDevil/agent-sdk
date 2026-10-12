// quick-start.md:104
import { createAgent, createMockProvider } from '@lousho/build-ai-agent';

const agent = createAgent({
  prompt: 'You are a helpful assistant.',
  provider: createMockProvider({ responses: ['Streaming works word by word.'] }),
});

const run = agent.stream('Tell me something.');
for await (const event of run) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
process.stdout.write('\n');

const result = await run.result;
console.log(result.finishReason); // "stop"
export {};
