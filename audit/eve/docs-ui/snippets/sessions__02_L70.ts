// sessions.md:70
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini' });
const session = agent.session({ id: 'user-42', turnPolicy: 'queue' });

const first = session.send('Find flights to Rome.');
const second = session.send('Only direct ones, please.'); // joins the first turn
console.log((await second) === (await first)); // true: one turn, one result
export {};
