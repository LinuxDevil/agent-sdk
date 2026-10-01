/**
 * AgentStore (LOU-D30): the stores an agent persists to, given to
 * `createAgent({ store })` in one option. `SqliteStore` is one;
 * `memoryStore()` builds an in-memory one.
 */

import type { Checkpoint, CheckpointStore } from '../execution/checkpoint';
import type { ApprovalStore } from '../execution/ApprovalGate';
import { InMemoryApprovalStore } from '../execution/InMemoryApprovalStore';
import { MemorySessionStore, type SessionStore } from '../session/sessionStore';

/**
 * Where an agent keeps session transcripts, durable-execution checkpoints
 * and paused approvals. Every part is optional: a part left out keeps its
 * default (in-memory transcripts and approvals, no checkpoints).
 *
 * @example
 * ```ts
 * const store: AgentStore = { sessions: new FileSessionStore('./.loushy/sessions'), approvals: new InMemoryApprovalStore() };
 * ```
 */
export interface AgentStore {
  /** Session transcripts: the default store of `agent.session()`. */
  sessions?: SessionStore;
  /** Checkpoints of session turns and of runs given a `sessionId`. */
  checkpoints?: CheckpointStore;
  /** Pending approvals: the default `approvalStore`. */
  approvals?: ApprovalStore;
}

/** Checkpoints in a Map, copied on save and load. */
class MemoryCheckpointStore implements CheckpointStore {
  private readonly checkpoints = new Map<string, Checkpoint>();

  async save(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    this.checkpoints.set(sessionId, structuredClone(checkpoint));
  }

  async load(sessionId: string): Promise<Checkpoint | null> {
    const checkpoint = this.checkpoints.get(sessionId);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async delete(sessionId: string): Promise<void> {
    this.checkpoints.delete(sessionId);
  }
}

/**
 * An {@link AgentStore} that keeps sessions, checkpoints and approvals in
 * memory, for as long as the process (and this object) lives. For tests
 * and scripts; use a `SqliteStore` to survive a restart.
 *
 * @example
 * ```ts
 * const agent = createAgent({ provider, store: memoryStore() });
 * await agent.session({ id: 'user-42' }).send('Hello');
 * ```
 */
export function memoryStore(): Required<AgentStore> {
  return {
    sessions: new MemorySessionStore(),
    checkpoints: new MemoryCheckpointStore(),
    approvals: new InMemoryApprovalStore(),
  };
}
