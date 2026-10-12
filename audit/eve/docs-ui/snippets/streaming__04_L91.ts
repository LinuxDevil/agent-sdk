// streaming.md:91
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  onEvent: (event) => {
    if (event.type === 'tool.start') console.log('calling', event.toolName, event.args);
    if (event.type === 'run.done') console.log('done:', event.finishReason, event.usage?.totalTokens);
  },
});

await agent.send('Weather in Paris?');
export {};
