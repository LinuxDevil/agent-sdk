// testing.md:164
import { createAgent, resolveProvider } from '@lousho/build-ai-agent';
import { recordReplay } from '@lousho/build-ai-agent/testing';

const provider = recordReplay(() => resolveProvider('openai/gpt-4o-mini'), {
  cassette: './__cassettes__/refund-flow.json',
  mode: process.env.LOUSHO_RECORD ? 'record' : 'replay', // or 'auto'
});
const agent = createAgent({ provider, prompt: 'You handle refund requests.' });
export {};
