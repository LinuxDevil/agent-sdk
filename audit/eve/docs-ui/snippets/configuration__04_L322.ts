// configuration.md:322
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  modelSettings: { maxTokens: 1024, temperature: 0.2 },
});

// This run sends maxTokens: 256 and temperature: 0.2.
await agent.send('Summarize the log in one line.', { modelSettings: { maxTokens: 256 } });
export {};
