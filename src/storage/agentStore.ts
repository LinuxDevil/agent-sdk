/**
 * AgentStore: the stores an agent persists to, given to
 * `createAgent({ store })` in one option. `SqliteStore` is one;
 * `memoryStore()` builds an in-memory one.
 */

import {
  appendToRing,
  listCheckpoints,
  newestFirst,
  resolveHistoryLimit,
  toHistoryEntry,
  type Checkpoint,
  type CheckpointDeleteOptions,
  type CheckpointHistoryEntry,
  type CheckpointHistoryOptions,
  type CheckpointListEntry,
  type CheckpointListOptions,
  type CheckpointStore,
} from '../execution/checkpoint';
import type { ApprovalStore } from '../execution/ApprovalGate';
import { isLiveLeaseOwner } from '../execution/runLease';
import { assertCheckpointId } from '../session/checkpointId';
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
  private readonly leases = new Map<string, { owner: string; expiresAt: number }>();
  private readonly historyLimit: number;

  constructor(options: MemoryStoreOptions = {}) {
    this.historyLimit = resolveHistoryLimit(options.historyLimit);
  }

  async save(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    assertCheckpointId(sessionId);
    this.checkpoints.set(sessionId, structuredClone(checkpoint));
    if (this.historyLimit > 0) {
      const entry = toHistoryEntry(structuredClone(checkpoint));
      this.rings.set(sessionId, appendToRing(this.rings.get(sessionId) ?? [], entry, this.historyLimit));
    }
  }

  async load(sessionId: string): Promise<Checkpoint | null> {
    assertCheckpointId(sessionId);
    const checkpoint = this.checkpoints.get(sessionId);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async delete(sessionId: string, options: CheckpointDeleteOptions = {}): Promise<void> {
    assertCheckpointId(sessionId);
    this.checkpoints.delete(sessionId);
    if (!options.keepHistory) this.rings.delete(sessionId);
  }

  async history(sessionId: string, options?: CheckpointHistoryOptions): Promise<CheckpointHistoryEntry[]> {
    return structuredClone(newestFirst(this.rings.get(sessionId) ?? [], options));
  }

  /** The latest checkpoint of every id, by id. */
  async list(options?: CheckpointListOptions): Promise<CheckpointListEntry[]> {
    return structuredClone(listCheckpoints(this.checkpoints, options));
  }

  /**
   * Run lease: free when expired, or when its run no longer runs in this
   * process (everything that shares this store lives in one process).
   */
  async acquireLease(sessionId: string, owner: string, ttlMs: number): Promise<boolean> {
    assertCheckpointId(sessionId);
    const now = Date.now();
    const held = this.leases.get(sessionId);
    if (held && held.owner !== owner && held.expiresAt > now && (held.owner.startsWith('claim:') || isLiveLeaseOwner(held.owner))) return false;
    this.leases.set(sessionId, { owner, expiresAt: now + ttlMs });
    for (const [id, lease] of this.leases) if (lease.expiresAt < now) this.leases.delete(id);
    return true;
  }

  /** Renews `owner`'s own lease; a lease that is gone or another owner's is not taken. */
  async renewLease(sessionId: string, owner: string, ttlMs: number): Promise<boolean> {
    const held = this.leases.get(sessionId);
    if (held?.owner !== owner) return false;
    held.expiresAt = Date.now() + ttlMs;
    return true;
  }

  /** Saves while `owner` holds the lease. */
  async saveIfLeased(sessionId: string, checkpoint: Checkpoint, owner: string): Promise<boolean> {
    if (this.leases.get(sessionId)?.owner !== owner) return false;
    await this.save(sessionId, checkpoint);
    return true;
  }

  async releaseLease(sessionId: string, owner: string): Promise<void> {
    if (this.leases.get(sessionId)?.owner === owner) this.leases.delete(sessionId);
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
