// approvals.md:222
import { createAgent } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';

const store = new SqliteStore('./.lousho/agent.db');
const agent = createAgent({ provider, tools: [emailTool], store }); // or approvalStore: store.approvals
export {};
