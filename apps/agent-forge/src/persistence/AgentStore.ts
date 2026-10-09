import type { AgentSpec } from '@lousho/build-ai-agent';

export interface AgentStoreEntry {
  id: string;
  spec: AgentSpec;
  updatedAt: string;
}

/**
 * Storage boundary for `AgentSpec`s (LOU-L3).
 *
 * Two implementations: `createFsAgentStore()` (Node-only, the server's real
 * `.lousho/agents/*.yaml` files - persistence/fsAgentStore.ts) and
 * `HttpAgentStore` (the browser app's, which reads and writes that same
 * store over `GET/PUT/DELETE /agents` - Eve DUI-F2). The app's UI code only
 * ever depends on `AgentStore`, never on `localStorage` or `node:fs`.
 */
export interface AgentStore {
  list(): Promise<AgentStoreEntry[]>;
  load(id: string): Promise<AgentSpec | undefined>;
  save(id: string, spec: AgentSpec): Promise<void>;
  remove(id: string): Promise<void>;
}
