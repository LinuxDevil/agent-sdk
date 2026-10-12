// testing.md:112
import { mockModel } from '@lousho/build-ai-agent/testing';

const model = mockModel([(req) => `You said: ${req.messages.at(-1)?.content}`]);
const result = await model.generate({ messages: [{ role: 'user', content: 'ping' }] });

console.log(result.text); // You said: ping
export {};
