/**
 * AgentStore (LOU-D30): the stores an agent persists to, given to
 * `createAgent({ store })` in one option. `SqliteStore` is one;
 * `memoryStore()` builds an in-memory one.
 */

import {
  appendToRing,
  newestFirst,
  resolveHistoryLimit,
  toHistoryEntry,
  type Checkpoint,
  type CheckpointDeleteOptions,
  type CheckpointHistoryEntry,
  type CheckpointHistoryOptions,
  type CheckpointStore,
} from '../execution/checkpoint';
import type { ApprovalStore } from '../execution/ApprovalGate';
import { InMemoryApprovalStore } from '../execution/InMemoryApprovalStore';
import { MemorySessionStore, type SessionStore } from '../session/sessionStore';
import { MemoryTokenStore } from '../oauth/memoryTokenStore';
import type { OAuthTokenStore } from '../oauth/types';

/**
 * Where an agent keeps session transcripts, durable-execution checkpoints
 * and paused approvals. Every part is optional: a part left out keeps its
 * default (in-memory transcripts and approvals, no checkpoints).
 *
 * @example
 * ```ts
 * const store: AgentStore = { sessions: new FileSessionStore('./.lousho/sessions'), approvals: new InMemoryApprovalStore() };
 * ```
 */
export interface AgentStore {
  /** Session transcripts: the default store of `agent.session()`. */
  sessions?: SessionStore;
  /** Checkpoints of session turns and of runs given a `sessionId`. */
  checkpoints?: CheckpointStore;
  /** Pending approvals: the default `approvalStore`. */
  approvals?: ApprovalStore;
  /**
   * OAuth access and refresh tokens, sign-ins in progress and registered
   * clients, keyed by provider and credential owner (see docs/oauth.md). The
   * file, SQLite and KV stores encrypt them with the application's `tokenKey`.
   */
  tokens?: OAuthTokenStore;
}

/** Checkpoints and their bounded history in Maps, copied on save and load. */
class MemoryCheckpointStore implements CheckpointStore {
  private readonly checkpoints = new Map<string, Checkpoint>();
  private readonly rings = new Map<string, CheckpointHistoryEntry[]>();
  private readonly historyLimit: number;

  constructor(options: MemoryStoreOptions = {}) {
    this.historyLimit = resolveHistoryLimit(options.historyLimit);
  }

  async save(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    this.checkpoints.set(sessionId, structuredClone(checkpoint));
    if (this.historyLimit > 0) {
      const entry = toHistoryEntry(structuredClone(checkpoint));
      this.rings.set(sessionId, appendToRing(this.rings.get(sessionId) ?? [], entry, this.historyLimit));
    }
  }

  async load(sessionId: string): Promise<Checkpoint | null> {
    const checkpoint = this.checkpoints.get(sessionId);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async delete(sessionId: string, options: CheckpointDeleteOptions = {}): Promise<void> {
    this.checkpoints.delete(sessionId);
    if (!options.keepHistory) this.rings.delete(sessionId);
  }

  async history(sessionId: string, options?: CheckpointHistoryOptions): Promise<CheckpointHistoryEntry[]> {
    return structuredClone(newestFirst(this.rings.get(sessionId) ?? [], options));
  }
}

/** Options for {@link memoryStore}. */
export interface MemoryStoreOptions {
  /** Checkpoints kept per session in `checkpoints.history()` (default 50, `0` keeps none). */
  historyLimit?: number;
}

/**
 * An {@link AgentStore} that keeps sessions, checkpoints, approvals and OAuth
 * tokens (unencrypted: nothing leaves the process) in memory, for as long as
 * the process (and this object) lives. For tests and scripts; use a
 * `SqliteStore` to survive a restart.
 *
 * @example
 * ```ts
 * const agent = createAgent({ provider, store: memoryStore() });
 * await agent.session({ id: 'user-42' }).send('Hello');
 * ```
 */
export function memoryStore(options: MemoryStoreOptions = {}): Required<AgentStore> {
  return {
    sessions: new MemorySessionStore(),
    checkpoints: new MemoryCheckpointStore(options),
    approvals: new InMemoryApprovalStore(),
    tokens: new MemoryTokenStore(),
  };
}
