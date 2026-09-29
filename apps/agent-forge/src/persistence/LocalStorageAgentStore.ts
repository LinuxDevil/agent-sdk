import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgentSpec } from '@loushy/build-ai-agent';
import type { AgentStore, AgentStoreEntry } from './AgentStore';

const KEY_PREFIX = 'agent-forge:agents:';

interface StoredRecord {
  spec: AgentSpec;
  updatedAt: string;
}

/**
 * Browser dev-experience implementation of `AgentStore`, backed by
 * `window.localStorage`. Values are stored as YAML text via the same
 * `yaml` package `loadSpec()` uses in the core SDK, so an entry saved here
 * is byte-for-byte the same format a `.loushy/agents/<id>.yaml` file would
 * hold (see fsAgentStore.ts) - only the storage medium differs.
 *
 * This is explicitly a stand-in until LOU-N's runtime control server ships
 * a real filesystem-backed store: it has no cross-device sync, no
 * multi-tab locking, and is bounded by the browser's localStorage quota.
 */
export class LocalStorageAgentStore implements AgentStore {
  constructor(private readonly storage: Storage = window.localStorage) {}

  private key(id: string): string {
    return `${KEY_PREFIX}${id}`;
  }

  async list(): Promise<AgentStoreEntry[]> {
    const entries: AgentStoreEntry[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
      const id = key.slice(KEY_PREFIX.length);
      const raw = this.storage.getItem(key);
      if (!raw) continue;
      const record = parseYaml(raw) as StoredRecord;
      entries.push({ id, spec: record.spec, updatedAt: record.updatedAt });
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  async load(id: string): Promise<AgentSpec | undefined> {
    const raw = this.storage.getItem(this.key(id));
    if (!raw) return undefined;
    const record = parseYaml(raw) as StoredRecord;
    return record.spec;
  }

  async save(id: string, spec: AgentSpec): Promise<void> {
    const record: StoredRecord = { spec, updatedAt: new Date().toISOString() };
    this.storage.setItem(this.key(id), stringifyYaml(record));
  }

  async remove(id: string): Promise<void> {
    this.storage.removeItem(this.key(id));
  }
}
