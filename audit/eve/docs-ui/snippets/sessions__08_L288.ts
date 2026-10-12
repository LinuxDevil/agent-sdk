// sessions.md:288
import { createAgent } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';

const store = new SqliteStore('./.lousho/agent.db'); // or ':memory:'
const agent = createAgent({ provider, store }); // transcripts, per-step checkpoints and approvals
await agent.session({ id: 'user-42' }).send('Hello');

store.prune({ olderThanMs: 7 * 24 * 60 * 60 * 1000 }); // { sessions, checkpoints, approvals, oauthPending } deleted
store.close();
export {};
