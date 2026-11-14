import { loadDatabaseSync, type SqlRow, type SqlValue } from '../../storage/sqlite/driver';
import { SDKError } from '../../execution/errors';

type SqlParam = SqlValue;

/** Statements with `?` placeholders on one SQL connection or transaction. */
export interface SqlStatements {
  /** Runs a statement and resolves to the number of rows it changed. */
  execute(sql: string, params?: readonly SqlParam[]): Promise<number>;
  /** Runs a query and resolves to its rows. */
  query(sql: string, params?: readonly SqlParam[]): Promise<SqlRow[]>;
}

/** A SQL connection or pool that Lousho's database stores run on, picking no ORM. */
export interface SqlClient extends SqlStatements {
  /** Runs `work` in one transaction: commits when it resolves, rolls back when it throws. */
  transaction<T>(work: (tx: SqlStatements) => Promise<T>): Promise<T>;
  /** Closes the connection, or leaves a host-owned pool open. */
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

/** One connection checked out of a `pg` Pool. */
export interface PgPoolClient extends PgQueryable {
  /** Returns the connection to the pool; given an error, the pool discards the connection instead. */
  release(error?: Error | boolean): void;
}

/** The part of a `pg` Pool that a database workspace source calls: queries, and one connection per transaction. */
export interface PgPool extends PgQueryable {
  /** Checks out one connection, so a transaction's statements run on it. */
  connect(): Promise<PgPoolClient>;
}

/** Options of `postgresHostBackend`. */
export interface PostgresOptions {
  /** Close the pool when the backend closes; default false, since the host owns its pool. */
  ownsPool?: boolean;
}

type Serial = <T>(work: () => Promise<T>) => Promise<T>;

function serialQueue(): Serial {
  let tail: Promise<unknown> = Promise.resolve();
  return (work) => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };
}

type SqliteDb = InstanceType<ReturnType<typeof loadDatabaseSync>>;

async function sqliteTransaction<T>(db: SqliteDb, direct: SqlStatements, work: (tx: SqlStatements) => Promise<T>): Promise<T> {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = await work(direct);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const SQLITE_CLIENT = Symbol.for('lousho.workspaces.sqliteSqlClient');

export function sqliteClientOnly(client: SqlClient, caller: string): SqlClient {
  if ((client as SqlClient & { [SQLITE_CLIENT]?: true })[SQLITE_CLIENT] !== true) {
    throw new SDKError(`${caller} takes a path or a client from sqliteSqlClient(); for Postgres use the postgres variant.`, 'LOUSHO_CONFIG_INVALID');
  }
  return client;
}

/** One SQLite connection (node:sqlite) whose calls and transactions run one at a time; open one per file per process and share it. */
export function sqliteSqlClient(path: string): SqlClient {
  const db = new (loadDatabaseSync())(path, { timeout: 5000 });
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  const direct: SqlStatements = {
    async execute(sql, params = []) {
      return Number(db.prepare(sql).run(...params).changes);
    },
    async query(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
  };
  const serial = serialQueue();
  const client: SqlClient = {
    execute: (sql, params) => serial(() => direct.execute(sql, params)),
    query: (sql, params) => serial(() => direct.query(sql, params)),
    transaction: (work) => serial(() => sqliteTransaction(db, direct, work)),
    async close() {
      db.close();
    },
  };
  return Object.defineProperty(client, SQLITE_CLIENT, { value: true, enumerable: true });
}

function numberPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function pgStatements(queryable: PgQueryable): SqlStatements {
  return {
    async execute(sql, params = []) {
      const result = await queryable.query(numberPlaceholders(sql), [...params]);
      return result.rowCount ?? 0;
    },
    async query(sql, params = []) {
      return (await queryable.query(numberPlaceholders(sql), [...params])).rows;
    },
  };
}

async function pgTransaction<T>(connect: PgPool['connect'] | undefined, work: (tx: SqlStatements) => Promise<T>): Promise<T> {
  if (!connect) throw new SDKError('A Postgres transaction needs a pg Pool to check one connection out of.', 'LOUSHO_CONFIG_INVALID');
  const connection = await connect();
  let broken: Error | boolean | undefined;
  try {
    await connection.query('BEGIN');
    const result = await work(pgStatements(connection));
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    broken = await rollback(connection);
    throw error;
  } finally {
    connection.release(broken);
  }
}

async function rollback(connection: PgPoolClient): Promise<Error | boolean | undefined> {
  try {
    await connection.query('ROLLBACK');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : true;
  }
}

export function postgresSqlClient(pool: PgQueryable, options: PostgresOptions = {}, connect?: PgPool['connect']): SqlClient {
  return {
    ...pgStatements(pool),
    transaction: (work) => pgTransaction(connect, work),
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
     thread_id TEXT, parent_run_id TEXT,
     PRIMARY KEY (project_id, workspace_id, run_id))`,
  'CREATE INDEX IF NOT EXISTS ws_runs_status ON ws_runs (project_id, workspace_id, status)',
  'CREATE TABLE IF NOT EXISTS ws_run_events (project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (project_id, workspace_id, run_id, seq))',
];

const ADDED_COLUMNS = ['ALTER TABLE ws_runs ADD COLUMN thread_id TEXT', 'ALTER TABLE ws_runs ADD COLUMN parent_run_id TEXT'];

function isDuplicateColumn(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return code === '42701' || (typeof message === 'string' && /duplicate column|already exists/i.test(message));
}

export async function migrateHostTables(client: SqlClient): Promise<void> {
  for (const statement of TABLES) await client.execute(statement);
  for (const statement of ADDED_COLUMNS) {
    await client.execute(statement).catch((error: unknown) => {
      if (!isDuplicateColumn(error)) throw error;
    });
  }
}
