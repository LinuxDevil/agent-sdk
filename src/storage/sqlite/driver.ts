import { SDKError } from '../../execution/errors';
/**
 * Minimal structural types for the parts of `node:sqlite` this package uses,
 * plus the lazy loader. `@types/node` older than 22.5 has no `node:sqlite`
 * typings, and loading it lazily keeps `import '@linuxdevil/lousho/sqlite'`
 * safe on Node versions that lack it.
 */

/** A row returned by a query. */
export type SqlRow = Record<string, unknown>;

/** A bind parameter. */
export type SqlValue = string | number | Uint8Array | null;

/** The subset of `StatementSync` used here. */
export interface SqlStatement {
  /** Runs the statement and reports how many rows changed. */
  run(...params: SqlValue[]): {
    /** How many rows changed. */
    changes: number | bigint;
  };
  /** Returns the first row, or `undefined` when there is none. */
  get(...params: SqlValue[]): SqlRow | undefined;
  /** Returns every row. */
  all(...params: SqlValue[]): SqlRow[];
}

/** The subset of `DatabaseSync` used here. */
export interface SqlDatabase {
  /** Runs SQL that returns no rows. */
  exec(sql: string): void;
  /** Prepares a statement. */
  prepare(sql: string): SqlStatement;
  /** Closes the database. */
  close(): void;
}

/** The constructor shape of `DatabaseSync`. */
export type SqlDatabaseConstructor = new (path: string, options?: { timeout?: number }) => SqlDatabase;

/** Oldest Node release in the 22 line that ships `node:sqlite` without a flag. */
const REQUIRED_NODE = '22.13.0';

/**
 * Load `DatabaseSync` from `node:sqlite`. Uses `process.getBuiltinModule` so it
 * works from both the ESM and the CJS build, and throws a clear error on a
 * Node that has no `node:sqlite`.
 */
export function loadDatabaseSync(): SqlDatabaseConstructor {
  let loaded: { DatabaseSync?: SqlDatabaseConstructor } | undefined;
  try {
    loaded = process.getBuiltinModule?.('node:sqlite') as typeof loaded;
  } catch {
    loaded = undefined;
  }
  if (!loaded?.DatabaseSync) {
    throw new SDKError(
      `SqliteStore needs the built-in 'node:sqlite' module (Node >= ${REQUIRED_NODE}), ` +
        `but this runtime (Node ${process.versions.node}) does not provide it. ` +
        'Upgrade Node, or use FileSessionStore / LocalStorageCheckpointStore instead.',
      'LOUSHO_STORAGE_FAILED'
    );
  }
  return loaded.DatabaseSync;
}
