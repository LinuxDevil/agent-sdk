import { loadDatabaseSync, type SqlRow, type SqlValue } from '../../storage/sqlite/driver';

/** A bind parameter of a {@link SqlClient} statement. */
export type SqlParam = SqlValue;

/** The one async SQL surface the host stores use: `?` placeholders, parameters always bound. */
export interface SqlClient {
  /** Runs a statement and returns how many rows it changed. */
  execute(sql: string, params?: readonly SqlParam[]): Promise<number>;
  /** Runs a statement and returns its rows (a `RETURNING` clause counts). */
  query(sql: string, params?: readonly SqlParam[]): Promise<SqlRow[]>;
  /** Closes the connection or pool. */
  close(): Promise<void>;
}

/** What a `pg` query resolves to. */
export interface PgResult {
  /** The rows returned. */
  rows: SqlRow[];
  /** How many rows changed, when the driver says. */
  rowCount: number | null;
}

/** The part of a `pg` Pool or Client that {@link postgresSqlClient} calls. */
export interface PgQueryable {
  /** Runs one statement with `$n` placeholders. */
  query(text: string, values?: unknown[]): Promise<PgResult>;
  /** Closes the pool or client. */
  end?(): Promise<void>;
}

/** A {@link SqlClient} over a SQLite file (or `':memory:'`) using the built-in `node:sqlite`. */
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

/** A {@link SqlClient} over a `pg` Pool or Client; the host owns the pool and its connection string. */
export function postgresSqlClient(pool: PgQueryable): SqlClient {
  return {
    async execute(sql, params = []) {
      const result = await pool.query(numberPlaceholders(sql), [...params]);
      return result.rowCount ?? 0;
    },
    async query(sql, params = []) {
      return (await pool.query(numberPlaceholders(sql), [...params])).rows;
    },
    async close() {
      await pool.end?.();
    },
  };
}

/** True when `error` is a unique-key violation on SQLite or Postgres. */
export function isUniqueViolation(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return code === '23505' || (typeof message === 'string' && /UNIQUE constraint failed|duplicate key/i.test(message));
}

const TABLES = [
  'CREATE TABLE IF NOT EXISTS ws_threads (key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS ws_checkpoints (key TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL, updated_at BIGINT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS ws_runs (
     run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, page_id TEXT NOT NULL,
     revision TEXT NOT NULL, status TEXT NOT NULL, started_at BIGINT NOT NULL, ended_at BIGINT)`,
  'CREATE INDEX IF NOT EXISTS ws_runs_scope ON ws_runs (project_id, workspace_id, status)',
  'CREATE TABLE IF NOT EXISTS ws_run_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (run_id, seq))',
];

/** Creates the host tables (`ws_threads`, `ws_checkpoints`, `ws_runs`, `ws_run_events`) when they are missing. */
export async function migrateHostTables(client: SqlClient): Promise<void> {
  for (const statement of TABLES) await client.execute(statement);
}
