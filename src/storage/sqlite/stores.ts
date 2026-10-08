import type { Message } from '../../providers/llm';
import {
  resolveHistoryLimit,
  type Checkpoint,
  type CheckpointDeleteOptions,
  type CheckpointHistoryEntry,
  type CheckpointHistoryOptions,
  type CheckpointStore,
} from '../../execution/checkpoint';
import type {
  ApprovalStore,
  ExecutionSnapshot,
  PendingApproval,
  ResolvedApproval,
} from '../../execution/ApprovalGate';
import { assertSessionId, decodeBytes, encodeBytes, type SessionStore } from '../../session/sessionStore';
import type { Connection } from './connection';
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

// `table` and `key` are fixed identifiers from this file, never user input.
const upsert = (table: string, key: string): string =>
  `INSERT INTO ${table} (${key}, payload, created_at, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(${key}) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`;

/** `SessionStore` over the `sessions` table. */
export class SqliteSessionStore implements SessionStore {
  private readonly sql: Statements;
  constructor(connection: Connection) {
    this.sql = new Statements(connection);
  }

  async load(id: string): Promise<Message[] | undefined> {
    assertSessionId(id);
    return parse<Message[]>(this.sql.get('SELECT payload FROM sessions WHERE id = ?').get(id));
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
    const now = Date.now();
    const payload = JSON.stringify(checkpoint, encodeBytes);
    this.connection.transaction(() => {
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
    });
  }

  async load(sessionId: string): Promise<Checkpoint | null> {
    const row = this.sql.get('SELECT payload FROM checkpoints WHERE session_id = ?').get(sessionId);
    return parse<Checkpoint>(row) ?? null;
  }

  async delete(sessionId: string, options: CheckpointDeleteOptions = {}): Promise<void> {
    this.connection.transaction(() => {
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
    this.connection.transaction(() => {
      this.sql.get(upsert('approvals', 'id')).run(pending.id, JSON.stringify(record, encodeBytes), now, now);
      // Saving again re-opens an approval that was already resolved.
      this.sql.get('UPDATE approvals SET resolved_at = NULL WHERE id = ?').run(pending.id);
    });
  }

  async resolve(id: string): Promise<ResolvedApproval | null> {
    return this.connection.transaction(() => {
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
}
