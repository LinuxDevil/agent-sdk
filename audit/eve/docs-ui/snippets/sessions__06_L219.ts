// sessions.md:219
import { createAgent, FileSessionStore } from '@lousho/build-ai-agent';

const agent = createAgent({ provider });
const store = new FileSessionStore('./.lousho/sessions');

const first = agent.session({ id: 'user-42', store });
await first.send('My name is Ali.');

// Later, even in another process or another createAgent() instance:
const again = agent.session({ id: 'user-42', store });
await again.send('What is my name?'); // "Ali"
export {};
