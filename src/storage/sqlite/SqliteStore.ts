import type { CheckpointStore } from '../../execution/checkpoint';
import type { ApprovalStore } from '../../execution/ApprovalGate';
import type { SessionStore } from '../../session/sessionStore';
import { Connection } from './connection';
import { SqliteApprovalStore, SqliteCheckpointStore, SqliteSessionStore, Statements } from './stores';

/** Options for {@link SqliteStore.prune}. */
export interface PruneOptions {
  /** Delete rows last updated more than this many milliseconds ago. */
  olderThanMs: number;
}

/** Options for {@link SqliteStore}. */
export interface SqliteStoreOptions {
  /** Checkpoints kept per session in `checkpoints.history()` (default 50, `0` keeps none). */
  historyLimit?: number;
}

/** How many rows {@link SqliteStore.prune} deleted, per kind. */
export interface PruneResult {
  sessions: number;
  checkpoints: number;
  approvals: number;
}

/**
 * One SQLite file holding sessions, checkpoints and approvals: durable,
 * transactional and zero-ops. Uses Node's built-in `node:sqlite` (no native
 * dependency; Node >= 22.13). WAL mode plus a busy timeout let several
 * processes share one file.
 *
 * @example
 * ```ts
 * import { SqliteStore } from '@loushy/build-ai-agent/sqlite';
 *
 * const store = new SqliteStore('./.loushy/agent.db'); // or ':memory:'
 * const session = agent.session({ id: 'user-42', store: store.sessions });
 * await AgentExecutor.execute({
 *   agent, input, provider, toolRegistry,
 *   sessionId: 'run-1',
 *   checkpointStore: store.checkpoints,
 *   approvalStore: store.approvals,
 * });
 * store.close();
 * ```
 */
export class SqliteStore {
  /** Session transcripts, for `agent.session({ store })`. */
  readonly sessions: SessionStore;
  /** Durable-execution checkpoints, for `checkpointStore`. */
  readonly checkpoints: CheckpointStore;
  /** Pending tool approvals, for `approvalStore`. */
  readonly approvals: ApprovalStore;
  private readonly connection: Connection;
  private readonly sql: Statements;

  /**
   * @param path database file (its directory is created if missing) or `':memory:'`
   * @param options `historyLimit`: checkpoints kept per session in `checkpoints.history()`
   * @throws if `node:sqlite` is unavailable, or `path` is not a SQLite database
   */
  constructor(path: string, options: SqliteStoreOptions = {}) {
    this.connection = Connection.open(path);
    this.sql = new Statements(this.connection);
    this.sessions = new SqliteSessionStore(this.connection);
    this.checkpoints = new SqliteCheckpointStore(this.connection, options);
    this.approvals = new SqliteApprovalStore(this.connection);
  }

  /** Absolute path of the database file (or `':memory:'`). */
  get path(): string {
    return this.connection.path;
  }

  /**
   * Delete stale sessions and checkpoints (by last update) and approvals that
   * were resolved more than `olderThanMs` ago. Unresolved approvals are kept.
   *
   * @example
   * ```ts
   * const removed = store.prune({ olderThanMs: 7 * 24 * 60 * 60 * 1000 });
   * console.log(removed); // { sessions: 3, checkpoints: 1, approvals: 0 }
   * ```
   */
  prune({ olderThanMs }: PruneOptions): PruneResult {
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
      throw new Error(`prune: olderThanMs must be a non-negative number of milliseconds, got ${olderThanMs}.`);
    }
    const cutoff = Date.now() - olderThanMs;
    return this.connection.transaction(() => {
      const run = (sql: string): number => Number(this.sql.get(sql).run(cutoff).changes);
      // Old history entries go too; the count stays the checkpoints deleted.
      run('DELETE FROM checkpoint_history WHERE saved_at < ?');
      return {
        sessions: run('DELETE FROM sessions WHERE updated_at < ?'),
        checkpoints: run('DELETE FROM checkpoints WHERE updated_at < ?'),
        approvals: run('DELETE FROM approvals WHERE resolved_at IS NOT NULL AND resolved_at < ?'),
      };
    });
  }

  /** Close the database. Any later use of the store or its parts throws. Safe to call twice. */
  close(): void {
    this.connection.close();
  }
}
