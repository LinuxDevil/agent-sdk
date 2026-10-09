/**
 * M10a: stores that outlive one `createAgent()` + `mountChannels()` pair, so a
 * second pair over the same stores is "the process after a restart". Sessions,
 * checkpoints (a `KVCheckpointStore` over a Map, JSON round-trip) and
 * approvals, all in memory.
 */
import { expect } from 'vitest';
import { KVCheckpointStore } from '../../deploy/kvCheckpointStore';
import { InMemoryApprovalStore } from '../../execution/InMemoryApprovalStore';
import type { Message } from '../../providers';
import { MemorySessionStore } from '../../session/sessionStore';

/** A `MemorySessionStore` that remembers which session ids were saved. */
class RecordingSessionStore extends MemorySessionStore {
  readonly ids = new Set<string>();

  override async save(id: string, messages: readonly Message[]): Promise<void> {
    this.ids.add(id);
    await super.save(id, messages);
  }

  // A session commits through saveIf (Eve DUR-F4), which does not go through save().
  override async saveIf(id: string, expectedRevision: string, messages: readonly Message[]): Promise<boolean> {
    const saved = await super.saveIf(id, expectedRevision, messages);
    if (saved) this.ids.add(id);
    return saved;
  }
}

export function durableStores() {
  const data = new Map<string, string>();
  const checkpoints = new KVCheckpointStore({
    get: async (key) => data.get(key) ?? null,
    put: async (key, value) => void data.set(key, value),
    delete: async (key) => void data.delete(key),
  });
  const sessions = new RecordingSessionStore();
  return {
    approvalStore: new InMemoryApprovalStore(),
    store: { sessions, checkpoints },
    /** The one saved transcript, as JSON. */
    async transcript(): Promise<string> {
      expect([...sessions.ids]).toHaveLength(1);
      return JSON.stringify(await sessions.load([...sessions.ids][0]));
    },
  };
}
