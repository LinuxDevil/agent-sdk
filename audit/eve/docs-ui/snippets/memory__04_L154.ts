// memory.md:154
import { createAgent, defineMemory } from '@lousho/build-ai-agent';
import { SqliteStore, sqliteMemory } from '@lousho/build-ai-agent/sqlite';

const store = new SqliteStore('./.lousho/agent.db');
const notes = defineMemory({ name: 'notes', scope: 'global', provider: sqliteMemory(store) });
const agent = createAgent({ model: 'openai/gpt-4o-mini', store, memory: [notes] });
export {};
