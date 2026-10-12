// providers.md:101
import { readFileSync } from 'node:fs';
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ instructions: 'Describe images briefly.', model: 'openai/gpt-4o-mini' });

// Parts become one user message.
const answer = await agent.send([
  { type: 'text', text: 'What is in these pictures?' },
  { type: 'image', image: 'https://example.com/cat.png' },
  { type: 'image', image: new Uint8Array(readFileSync('dog.png')), mimeType: 'image/png' },
]);
console.log(answer.text);
export {};
