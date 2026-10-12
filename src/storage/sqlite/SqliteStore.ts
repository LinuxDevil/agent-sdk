import type { CheckpointStore } from '../../execution/checkpoint';
import type { ApprovalStore } from '../../execution/ApprovalGate';
import type { SessionStore } from '../../session/sessionStore';
import { Connection } from './connection';
import { leaseOfRow, SqliteApprovalStore, SqliteCheckpointStore, SqliteSessionStore, Statements } from './stores';
import { leaseAvailable } from '../leaseRecord';
import { approvalExpired } from '../../execution/ApprovalGate';
import { SDKError } from '../../execution/errors';
import type { OAuthTokenStore } from '../../oauth/types';
import type { TokenKeyInput } from '../../oauth/tokenCipher';
import { sqliteTokenStore } from './tokenStore';

/** A session turn's checkpoint id, `<session id>.turn-<n>` (AgentSession). */
const TURN_CHECKPOINT = /^(.+)\.turn-\d+$/;

/** Options for {@link SqliteStore.prune}. */
export interface PruneOptions {
  /** Delete rows last updated more than this many milliseconds ago. */
  olderThanMs: number;
  /**
   * Also delete unresolved approvals whose `approvalTtlMs` deadline
   * (`expiresAt`) has passed: deciding them could only deny them. Their runs
   * are then no longer kept as paused, so an old one goes like any other old
   * run. Default `false`.
   */
  expiredApprovals?: boolean;
}

/** Options for {@link SqliteStore}. */
export interface SqliteStoreOptions {
  /** Checkpoints kept per session in `checkpoints.history()` (default 50, `0` keeps none). */
  historyLimit?: number;
  /**
   * Key of the OAuth tokens in `store.tokens`: 32 random bytes as base64
   * (`generateTokenKey()`), or several, newest first, to read tokens written
   * under an older key. Default: the `LOUSHO_TOKEN_KEY` environment variable.
   * Only needed once something stores a token.
   */
  tokenKey?: TokenKeyInput;
}

/** How many rows {@link SqliteStore.prune} deleted, per kind. */
export interface PruneResult {
  sessions: number;
  checkpoints: number;
  /** Approvals resolved before the cutoff, plus, with `expiredApprovals: true`, unresolved ones past their deadline. */
  approvals: number;
  /** Expired pending OAuth sign-ins (deleted whatever `olderThanMs` is). */
  oauthPending: number;
}

/**
 * One SQLite file holding sessions, checkpoints and approvals: durable,
 * transactional and zero-ops. Uses Node's built-in `node:sqlite` (no native
 * dependency; Node >= 22.13). WAL mode plus a busy timeout let several
 * processes share one file.
 *
 * @example
 * ```ts
 * import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
 *
 * const store = new SqliteStore('./.lousho/agent.db'); // or ':memory:'
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
  /** OAuth tokens, pending sign-ins and registered clients, encrypted with `tokenKey` (docs/oauth.md). */
  readonly tokens: OAuthTokenStore;
  /** @internal The open database, shared with `sqliteMemory()`. */
  readonly connection: Connection;
  private readonly sql: Statements;

  /**
   * @param path database file (its directory is created if missing) or `':memory:'`
   * @param options `historyLimit`: checkpoints kept per session in `checkpoints.history()`; `tokenKey`: the key of `tokens`
   * @throws if `node:sqlite` is unavailable, `path` is not a SQLite database, or `tokenKey` is not 32 bytes of base64
   */
  constructor(path: string, options: SqliteStoreOptions = {}) {
    this.connection = Connection.open(path);
    this.sql = new Statements(this.connection);
    this.sessions = new SqliteSessionStore(this.connection);
    this.checkpoints = new SqliteCheckpointStore(this.connection, options);
    this.approvals = new SqliteApprovalStore(this.connection);
    try {
      this.tokens = sqliteTokenStore(this.connection, { tokenKey: options.tokenKey });
    } catch (error) {
      this.connection.close(); // a malformed tokenKey: leave no open handle behind
      throw error;
    }
  }

  /** Absolute path of the database file (or `':memory:'`). */
  get path(): string {
    return this.connection.path;
  }

  /**
   * Delete stale sessions and checkpoints (by last update), approvals that
   * were resolved more than `olderThanMs` ago, and expired pending OAuth
   * sign-ins. Unresolved approvals and OAuth tokens are kept, and so is a run
   * paused on an unresolved approval, however old: its checkpoint
   * (`<id>.turn-<n>` for a session turn), that checkpoint's history and the
   * session's transcript (Eve DUR-F6). A run that is running now (its run
   * lease is live) or whose checkpoint was saved after the cutoff is kept with
   * its session's transcript too. `expiredApprovals: true` also deletes
   * unresolved approvals past their deadline.
   *
   * @example
   * ```ts
   * const removed = store.prune({ olderThanMs: 7 * 24 * 60 * 60 * 1000 });
   * console.log(removed); // { sessions: 3, checkpoints: 1, approvals: 0, oauthPending: 0 }
   * ```
   */
  prune({ olderThanMs, expiredApprovals = false }: PruneOptions): PruneResult {
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
      throw new SDKError(`prune: olderThanMs must be a non-negative number of milliseconds, got ${olderThanMs}.`, 'LOUSHO_CONFIG_INVALID');
    }
    const cutoff = Date.now() - olderThanMs;
    return this.connection.transaction(() => {
      const expired = expiredApprovals ? this.deleteExpiredApprovals() : 0;
      const paused = this.pausedRuns(cutoff);
      // Deletes the rows older than the cutoff whose `owner` (a session or run id) no paused run needs.
      const prune = (table: string, key: string, owner: string, column: string, keep: Set<string>): number => {
        const stale = this.sql
          .get(`SELECT ${key} AS pk, ${owner} AS owner FROM ${table} WHERE ${column} < ?`)
          .all(cutoff)
          .filter((row) => !keep.has(String(row.owner)));
        for (const row of stale) this.sql.get(`DELETE FROM ${table} WHERE ${key} = ?`).run(row.pk as string | number);
        return stale.length;
      };
      // Old history entries go too; the count stays the checkpoints deleted.
      prune('checkpoint_history', 'id', 'session_id', 'saved_at', paused.checkpoints);
      return {
        sessions: prune('sessions', 'id', 'id', 'updated_at', paused.sessions),
        checkpoints: prune('checkpoints', 'session_id', 'session_id', 'updated_at', paused.checkpoints),
        approvals: expired + Number(this.sql.get('DELETE FROM approvals WHERE resolved_at IS NOT NULL AND resolved_at < ?').run(cutoff).changes),
        oauthPending: Number(this.sql.get('DELETE FROM oauth_pending WHERE expires_at <= ?').run(Date.now()).changes),
      };
    });
  }

  /** Deletes the unresolved approvals whose deadline (`expiresAt`) passed; returns how many. */
  private deleteExpiredApprovals(): number {
    const rows = this.sql.get("SELECT id, json_extract(payload, '$.pending.expiresAt') AS expires_at FROM approvals WHERE resolved_at IS NULL").all();
    const expired = rows.filter((row) => typeof row.expires_at === 'string' && approvalExpired({ expiresAt: row.expires_at }));
    for (const row of expired) this.sql.get('DELETE FROM approvals WHERE id = ?').run(String(row.id));
    return expired.length;
  }

  /**
   * The checkpoints and sessions prune keeps: of runs paused on an unresolved
   * approval (the run each approval's snapshot names, any checkpoint that
   * names an unresolved approval as its own), of runs that may be running (a
   * live run lease, a checkpoint saved at or after `cutoff`), and the session
   * `<id>` of a `<id>.turn-<n>` session turn (a bare run id is its own session).
   */
  private pausedRuns(cutoff: number): { checkpoints: Set<string>; sessions: Set<string> } {
    const leased = this.sql
      .get('SELECT id, owner, expires_at, host, pid_space, pid_start, ttl_ms FROM leases')
      .all()
      .filter((row) => !leaseAvailable(leaseOfRow(row), ''))
      .map((row) => ({ run: row.id }));
    const runs = [
      ...this.sql.get("SELECT json_extract(payload, '$.snapshot.sessionId') AS run FROM approvals WHERE resolved_at IS NULL").all(),
      ...this.sql
        .get(
          `SELECT session_id AS run FROM checkpoints
           WHERE json_extract(payload, '$.approvalId') IN (SELECT id FROM approvals WHERE resolved_at IS NULL)`
        )
        .all(),
      ...leased,
    ]
      .map((row) => row.run)
      .filter((run): run is string => typeof run === 'string' && run !== '');
    // A checkpoint saved after the cutoff is kept anyway (its older history entries may go); it keeps its session.
    const recent = this.sql
      .get('SELECT session_id AS run FROM checkpoints WHERE updated_at >= ?')
      .all(cutoff)
      .map((row) => String(row.run));
    const sessions = [...runs, ...recent].map((run) => TURN_CHECKPOINT.exec(run)?.[1] ?? run);
    return { checkpoints: new Set(runs), sessions: new Set(sessions) };
  }

  /** Close the database. Any later use of the store or its parts throws. Safe to call twice. */
  close(): void {
    this.connection.close();
  }
}
