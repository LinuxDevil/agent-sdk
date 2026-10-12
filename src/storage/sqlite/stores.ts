import type { Message } from '../../providers/llm';
import {
  HAS_CHECKPOINT_HISTORY,
  listCheckpoints,
  listedCheckpoint,
  parseCheckpoint,
  resolveHistoryLimit,
  type Checkpoint,
  type CheckpointDeleteOptions,
  type CheckpointHistoryEntry,
  type CheckpointHistoryOptions,
  type CheckpointListEntry,
  type CheckpointListOptions,
  type CheckpointStore,
} from '../../execution/checkpoint';
import {
  oldestFirst,
  type ApprovalStore,
  type ExecutionSnapshot,
  type PendingApproval,
  type ResolvedApproval,
} from '../../execution/ApprovalGate';
import { assertSessionId, decodeBytes, encodeBytes, transcriptRevision, type SessionStore } from '../../session/sessionStore';
import type { Connection } from './connection';
import { SDKError } from '../../execution/errors';
import { assertCheckpointId } from '../../session/checkpointId';
import { LEASE_SWEEP_AGE_MS, leaseAvailable, newLeaseRecord, type LeaseRecord } from '../leaseRecord';
import type { SqlStatement } from './driver';

/** Prepared statements, prepared once each; `connection.db` throws a clear error after close. */
export class Statements {
  private readonly cache = new Map<string, SqlStatement>();
  constructor(private readonly connection: Connection) {}

  get(sql: string): SqlStatement {
    const db = this.connection.db;
    let statement = this.cache.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      this.cache.set(sql, statement);
    }
    return statement;
  }
}

const parse = <T>(row: { payload?: unknown } | undefined): T | undefined =>
  row === undefined ? undefined : (JSON.parse(String(row.payload), decodeBytes) as T);

/** A `leases` row as a lease record; `undefined` without a row. */
export function leaseOfRow(row: Record<string, unknown> | undefined): LeaseRecord | undefined {
  if (row === undefined) return undefined;
  return {
    owner: String(row.owner),
    expiresAt: Number(row.expires_at),
    ...(typeof row.host === 'string' && { host: row.host }),
    ...(typeof row.pid_space === 'string' && { pidSpace: row.pid_space }),
    ...(typeof row.pid_start === 'string' && { pidStart: row.pid_start }),
    ...(row.ttl_ms !== null && row.ttl_ms !== undefined && { ttlMs: Number(row.ttl_ms) }),
  };
}

/** A transcript row, or `LOUSHO_SESSION_FILE_CORRUPT` when it is not a JSON array of messages. */
function parseTranscript(row: { payload?: unknown } | undefined, id: string): Message[] | undefined {
  if (row === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row.payload), decodeBytes);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    throw new SDKError(`The transcript of session '${id}' in the SQLite sessions table is corrupt: expected a JSON array of messages.`, 'LOUSHO_SESSION_FILE_CORRUPT');
  }
  return parsed as Message[];
}

// `table` and `key` are fixed identifiers from this file, never user input.
const upsert = (table: string, key: string): string =>
  `INSERT INTO ${table} (${key}, payload, created_at, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(${key}) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`;

/** `SessionStore` over the `sessions` table. */
export class SqliteSessionStore implements SessionStore {
  private readonly sql: Statements;
  constructor(private readonly connection: Connection) {
    this.sql = new Statements(connection);
  }

  async load(id: string): Promise<Message[] | undefined> {
    assertSessionId(id);
    return parseTranscript(this.sql.get('SELECT payload FROM sessions WHERE id = ?').get(id), id);
  }

  async save(id: string, messages: readonly Message[]): Promise<void> {
    assertSessionId(id);
    const now = Date.now();
    this.sql.get(upsert('sessions', 'id')).run(id, JSON.stringify(messages, encodeBytes), now, now);
  }

  async delete(id: string): Promise<void> {
    assertSessionId(id);
    this.sql.get('DELETE FROM sessions WHERE id = ?').run(id);
  }

  /** Eve DUR-F4: the read, compare and write run in one `BEGIN IMMEDIATE` transaction, so another process cannot slip between. */
  async saveIf(id: string, expectedRevision: string, messages: readonly Message[]): Promise<boolean> {
    assertSessionId(id);
    const payload = JSON.stringify(messages, encodeBytes);
    return this.connection.transactionAsync(() => {
      const stored = parseTranscript(this.sql.get('SELECT payload FROM sessions WHERE id = ?').get(id), id);
      if (transcriptRevision(stored) !== expectedRevision) return false;
      const now = Date.now();
      this.sql.get(upsert('sessions', 'id')).run(id, payload, now, now);
      return true;
    });
  }
}

/**
 * `CheckpointStore` over the `checkpoints` table (the latest checkpoint) and
 * the `checkpoint_history` table (the last `historyLimit` saves per session).
 * Checkpoints are stored as opaque JSON.
 */
export class SqliteCheckpointStore implements CheckpointStore {
  private readonly sql: Statements;
  private readonly historyLimit: number;
  constructor(
    private readonly connection: Connection,
    options: { historyLimit?: number } = {}
  ) {
    this.sql = new Statements(connection);
    this.historyLimit = resolveHistoryLimit(options.historyLimit);
  }

  async save(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    assertCheckpointId(sessionId);
    const payload = JSON.stringify(checkpoint, encodeBytes);
    await this.connection.transactionAsync(() => this.writeCheckpoint(sessionId, checkpoint, payload));
  }

  /** The writes of a save, inside the caller's transaction. */
  private writeCheckpoint(sessionId: string, checkpoint: Checkpoint, payload: string): void {
    const now = Date.now();
    this.sql.get(upsert('checkpoints', 'session_id')).run(sessionId, payload, now, now);
    if (this.historyLimit === 0) return;
    this.sql
      .get('INSERT INTO checkpoint_history (session_id, step, status, saved_at, payload) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, checkpoint.stepIndex, checkpoint.status ?? 'in-progress', now, payload);
    this.sql
      .get(
        `DELETE FROM checkpoint_history WHERE session_id = ? AND id NOT IN
         (SELECT id FROM checkpoint_history WHERE session_id = ? ORDER BY id DESC LIMIT ?)`
      )
      .run(sessionId, sessionId, this.historyLimit);
  }

  async load(sessionId: string): Promise<Checkpoint | null> {
    assertCheckpointId(sessionId);
    const row = this.sql.get('SELECT payload FROM checkpoints WHERE session_id = ?').get(sessionId);
    return row === undefined ? null : parseCheckpoint(String(row.payload), sessionId, 'the SQLite checkpoints table', decodeBytes);
  }

  async delete(sessionId: string, options: CheckpointDeleteOptions = {}): Promise<void> {
    assertCheckpointId(sessionId);
    await this.connection.transactionAsync(() => {
      this.sql.get('DELETE FROM checkpoints WHERE session_id = ?').run(sessionId);
      if (!options.keepHistory) this.sql.get('DELETE FROM checkpoint_history WHERE session_id = ?').run(sessionId);
    });
  }

  async history(sessionId: string, options?: CheckpointHistoryOptions): Promise<CheckpointHistoryEntry[]> {
    const limit = options?.limit === undefined ? -1 : Math.max(0, options.limit); // -1: no limit
    const rows = this.sql
      .get('SELECT step, status, saved_at, payload FROM checkpoint_history WHERE session_id = ? ORDER BY id DESC LIMIT ?')
      .all(sessionId, limit);
    return rows.map((row) => ({
      step: Number(row.step),
      savedAt: new Date(Number(row.saved_at)).toISOString(),
      status: String(row.status) as CheckpointHistoryEntry['status'],
      checkpoint: JSON.parse(String(row.payload), decodeBytes) as Checkpoint,
    }));
  }
  /** Whether `sessionId` has checkpoint history, without reading it. */
  async [HAS_CHECKPOINT_HISTORY](sessionId: string): Promise<boolean> {
    return this.sql.get('SELECT 1 FROM checkpoint_history WHERE session_id = ? LIMIT 1').get(sessionId) !== undefined;
  }

  /** Eve DUR-F15: the latest checkpoint of every id, by id. */
  async list(options?: CheckpointListOptions): Promise<CheckpointListEntry[]> {
    const rows = this.sql.get('SELECT session_id, payload FROM checkpoints ORDER BY session_id').all();
    return listCheckpoints(
      // A row that cannot be read is listed as the run `load()` fails on.
      rows.map((row) => listedCheckpoint(String(row.session_id), () => parseCheckpoint(String(row.payload), String(row.session_id), 'the SQLite checkpoints table', decodeBytes))),
      options
    );
  }

  /** Run lease: the read, check and write run in one `BEGIN IMMEDIATE` transaction (see `leaseRecord.ts`). */
  async acquireLease(sessionId: string, owner: string, ttlMs: number): Promise<boolean> {
    assertCheckpointId(sessionId);
    return this.connection.transactionAsync(() => {
      if (!leaseAvailable(this.leaseOf(sessionId), owner)) return false;
      this.writeLease(sessionId, owner, ttlMs);
      this.sql.get('DELETE FROM leases WHERE expires_at < ?').run(Date.now() - LEASE_SWEEP_AGE_MS);
      return true;
    });
  }

  /** Renews `owner`'s own lease in one transaction; a lease that is gone or another owner's is not taken. */
  async renewLease(sessionId: string, owner: string, ttlMs: number): Promise<boolean> {
    assertCheckpointId(sessionId);
    return this.connection.transactionAsync(() => {
      if (this.leaseOf(sessionId)?.owner !== owner) return false;
      this.writeLease(sessionId, owner, ttlMs);
      return true;
    });
  }

  /** Saves in the transaction that checks `owner` still holds the lease. */
  async saveIfLeased(sessionId: string, checkpoint: Checkpoint, owner: string): Promise<boolean> {
    assertCheckpointId(sessionId);
    const payload = JSON.stringify(checkpoint, encodeBytes);
    return this.connection.transactionAsync(() => {
      if (this.leaseOf(sessionId)?.owner !== owner) return false;
      this.writeCheckpoint(sessionId, checkpoint, payload);
      return true;
    });
  }

  private leaseOf(sessionId: string): LeaseRecord | undefined {
    return leaseOfRow(this.sql.get('SELECT owner, expires_at, host, pid_space, pid_start, ttl_ms FROM leases WHERE id = ?').get(sessionId));
  }

  private writeLease(sessionId: string, owner: string, ttlMs: number): void {
    const lease = newLeaseRecord(owner, ttlMs);
    this.sql
      .get(
        `INSERT INTO leases (id, owner, expires_at, host, pid_space, pid_start, ttl_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at, host = excluded.host,
         pid_space = excluded.pid_space, pid_start = excluded.pid_start, ttl_ms = excluded.ttl_ms`
      )
      .run(sessionId, owner, lease.expiresAt, lease.host, lease.pidSpace ?? null, lease.pidStart ?? null, ttlMs);
  }

  /** Like the other lease operations, waits out a busy database instead of failing (a lease left behind blocks the run for a minute). */
  async releaseLease(sessionId: string, owner: string): Promise<void> {
    await this.connection.transactionAsync(() => {
      this.sql.get('DELETE FROM leases WHERE id = ? AND owner = ?').run(sessionId, owner);
    });
  }
}

/**
 * `ApprovalStore` over the `approvals` table. `resolve` claims the row in one
 * transaction (so two processes cannot both resume it) and stamps
 * `resolved_at`; the row stays until `prune()` removes it.
 */
export class SqliteApprovalStore implements ApprovalStore {
  private readonly sql: Statements;
  constructor(private readonly connection: Connection) {
    this.sql = new Statements(connection);
  }

  async save(pending: PendingApproval, snapshot: ExecutionSnapshot): Promise<void> {
    const record: ResolvedApproval = { pending, snapshot };
    const now = Date.now();
    await this.connection.transactionAsync(() => {
      this.sql.get(upsert('approvals', 'id')).run(pending.id, JSON.stringify(record, encodeBytes), now, now);
      // Saving again re-opens an approval that was already resolved.
      this.sql.get('UPDATE approvals SET resolved_at = NULL WHERE id = ?').run(pending.id);
    });
  }

  async resolve(id: string): Promise<ResolvedApproval | null> {
    return this.connection.transactionAsync(() => {
      const row = this.sql.get('SELECT payload FROM approvals WHERE id = ? AND resolved_at IS NULL').get(id);
      if (row === undefined) return null;
      const now = Date.now();
      this.sql.get('UPDATE approvals SET resolved_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
      return parse<ResolvedApproval>(row) ?? null;
    });
  }

  async load(id: string): Promise<ResolvedApproval | null> {
    const row = this.sql.get('SELECT payload FROM approvals WHERE id = ? AND resolved_at IS NULL').get(id);
    return parse<ResolvedApproval>(row) ?? null;
  }

  /** Eve TOOLS-F13: every approval not resolved yet, oldest first. */
  async list(): Promise<PendingApproval[]> {
    const rows = this.sql.get('SELECT payload FROM approvals WHERE resolved_at IS NULL ORDER BY created_at, id').all();
    return oldestFirst(rows.flatMap((row) => parse<ResolvedApproval>(row)?.pending ?? []));
  }
}
