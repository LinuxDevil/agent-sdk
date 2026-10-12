// sessions.md:8
import { createAgent } from '@lousho/build-ai-agent';

const chat = createAgent({ instructions: 'Be brief.', provider });

const session = chat.session(); // in memory, new generated id
await session.send('My name is Ali.');
const { text } = await session.send('What is my name?'); // sees the first exchange

console.log(session.id, session.messages.length);
export {};
