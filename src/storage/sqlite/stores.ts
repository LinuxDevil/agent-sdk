import type { Message } from '../../providers/llm';
import type { Checkpoint, CheckpointStore } from '../../execution/checkpoint';
import type {
  ApprovalStore,
  ExecutionSnapshot,
  PendingApproval,
  ResolvedApproval,
} from '../../execution/ApprovalGate';
import { assertSessionId, type SessionStore } from '../../session/sessionStore';
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
  row === undefined ? undefined : (JSON.parse(String(row.payload)) as T);

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
    this.sql.get(upsert('sessions', 'id')).run(id, JSON.stringify(messages), now, now);
  }

  async delete(id: string): Promise<void> {
    assertSessionId(id);
    this.sql.get('DELETE FROM sessions WHERE id = ?').run(id);
  }
}

/** `CheckpointStore` over the `checkpoints` table. The checkpoint is stored as opaque JSON. */
export class SqliteCheckpointStore implements CheckpointStore {
  private readonly sql: Statements;
  constructor(connection: Connection) {
    this.sql = new Statements(connection);
  }

  async save(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    const now = Date.now();
    this.sql.get(upsert('checkpoints', 'session_id')).run(sessionId, JSON.stringify(checkpoint), now, now);
  }

  async load(sessionId: string): Promise<Checkpoint | null> {
    const row = this.sql.get('SELECT payload FROM checkpoints WHERE session_id = ?').get(sessionId);
    return parse<Checkpoint>(row) ?? null;
  }

  async delete(sessionId: string): Promise<void> {
    this.sql.get('DELETE FROM checkpoints WHERE session_id = ?').run(sessionId);
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
      this.sql.get(upsert('approvals', 'id')).run(pending.id, JSON.stringify(record), now, now);
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
}
