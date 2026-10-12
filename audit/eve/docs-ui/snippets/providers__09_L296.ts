// providers.md:296
import { createAgent } from '@lousho/build-ai-agent';

// OpenRouter's `openai/gpt-4o-mini`, through pi's openrouter adapter:
const agent = createAgent({ model: 'pi/openrouter/openai/gpt-4o-mini' });
export {};
