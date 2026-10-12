// sessions.md:155
import { createAgent } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';

const agent = createAgent({ provider, store: new SqliteStore('./.lousho/agent.db') });

// After a restart: finish the turn that was running, if any.
const finished = await agent.resume('user-42'); // ExecutionResult, or null when nothing was pending
console.log(finished?.text, await agent.session({ id: 'user-42' }).pending()); // pending() is null now
export {};
