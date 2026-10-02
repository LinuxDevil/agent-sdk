import type { AgentSpec } from '@lousho/build-ai-agent';

export interface AgentStoreEntry {
  id: string;
  spec: AgentSpec;
  updatedAt: string;
}

/**
 * Storage boundary for `AgentSpec`s (LOU-L3).
 *
 * This app (Vite + browser, no backend yet - that's LOU-N's runtime control
 * server) cannot touch the real filesystem, so `AgentStore` is the seam:
 * today it's implemented by `LocalStorageAgentStore` (browser-only, backed
 * by `window.localStorage`, good enough for a dev experience with autosave)
 * and by `createFsAgentStore()` (Node-only, reads/writes real
 * `.lousho/agents/*.yaml` files via the SDK's own YAML format - see
 * persistence/fsAgentStore.ts) for use once a server exists.
 *
 * LOU-N's runtime control server should implement this same interface
 * against the real filesystem and swap it in behind whatever transport it
 * adds (HTTP/IPC) - the app's UI code should only ever depend on
 * `AgentStore`, never on `localStorage` or `node:fs` directly.
 */
export interface AgentStore {
  list(): Promise<AgentStoreEntry[]>;
  load(id: string): Promise<AgentSpec | undefined>;
  save(id: string, spec: AgentSpec): Promise<void>;
  remove(id: string): Promise<void>;
}
