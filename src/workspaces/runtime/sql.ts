import { loadDatabaseSync, type SqlRow, type SqlValue } from '../../storage/sqlite/driver';

type SqlParam = SqlValue;

export interface SqlClient {
  execute(sql: string, params?: readonly SqlParam[]): Promise<number>;
  query(sql: string, params?: readonly SqlParam[]): Promise<SqlRow[]>;
  close(): Promise<void>;
}

/** The part of a `pg` Pool or Client that `postgresHostBackend` calls. */
export interface PgQueryable {
  /** Runs one statement with `$n` placeholders. */
  query(
    text: string,
    values?: unknown[]
  ): Promise<{
    /** The rows returned. */
    rows: Array<Record<string, unknown>>;
    /** How many rows changed, when the driver says. */
    rowCount: number | null;
  }>;
  /** Closes the pool or client. */
  end?(): Promise<void>;
}

/** Options of `postgresHostBackend`. */
export interface PostgresOptions {
  /** Close the pool when the backend closes; default false, since the host owns its pool. */
  ownsPool?: boolean;
}

export function sqliteSqlClient(path: string): SqlClient {
  const db = new (loadDatabaseSync())(path, { timeout: 5000 });
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  return {
    async execute(sql, params = []) {
      return Number(db.prepare(sql).run(...params).changes);
    },
    async query(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    async close() {
      db.close();
    },
  };
}

function numberPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

export function postgresSqlClient(pool: PgQueryable, options: PostgresOptions = {}): SqlClient {
  return {
    async execute(sql, params = []) {
      const result = await pool.query(numberPlaceholders(sql), [...params]);
      return result.rowCount ?? 0;
    },
    async query(sql, params = []) {
      return (await pool.query(numberPlaceholders(sql), [...params])).rows;
    },
    async close() {
      if (options.ownsPool) await pool.end?.();
    },
  };
}

export function isUniqueViolation(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return code === '23505' || (typeof message === 'string' && /UNIQUE constraint failed|duplicate key/i.test(message));
}

const TABLES = [
  'CREATE TABLE IF NOT EXISTS ws_threads (key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS ws_checkpoints (key TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL, updated_at BIGINT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS ws_runs (
     project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL, page_id TEXT NOT NULL,
     revision TEXT NOT NULL, status TEXT NOT NULL, started_at BIGINT NOT NULL, ended_at BIGINT,
     PRIMARY KEY (project_id, workspace_id, run_id))`,
  'CREATE INDEX IF NOT EXISTS ws_runs_status ON ws_runs (project_id, workspace_id, status)',
  'CREATE TABLE IF NOT EXISTS ws_run_events (project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (project_id, workspace_id, run_id, seq))',
];

export async function migrateHostTables(client: SqlClient): Promise<void> {
  for (const statement of TABLES) await client.execute(statement);
}
