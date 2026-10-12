// providers.md:45
import { createAgent, createMockProvider, resolveProvider } from '@lousho/build-ai-agent';

const fromString = createAgent({ model: 'anthropic/claude-sonnet-5-5' });
const fromInstance = createAgent({ provider: resolveProvider('openai/gpt-4o-mini'), model: 'gpt-4o' });
const offline = createAgent({ provider: createMockProvider({ responses: ['Hi! How can I help?'] }) });
export {};
