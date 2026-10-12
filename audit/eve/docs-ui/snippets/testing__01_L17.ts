// testing.md:17
import { createAgent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const model = mockModel(['Hello! How can I help?']);
const agent = createAgent({ prompt: 'You are friendly.', provider: model });

const result = await agent.send('hi');

console.log(result.text); // Hello! How can I help?
console.log(model.calls.length); // 1
model.assertExhausted();
export {};
