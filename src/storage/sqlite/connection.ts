import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadDatabaseSync, type SqlDatabase } from './driver';
import { migrate } from './migrations';
import { SDKError } from '../../execution/errors';

/** Milliseconds a writer waits for another process's lock before failing. */
const BUSY_TIMEOUT_MS = 5000;

/** One open database shared by the three stores, with open-state and transaction helpers. */
export class Connection {
  private database: SqlDatabase | undefined;

  private constructor(
    readonly path: string,
    database: SqlDatabase
  ) {
    this.database = database;
  }

  /** Open (creating the directory and file as needed), configure and migrate. */
  static open(path: string): Connection {
    const DatabaseSync = loadDatabaseSync();
    const location = path === ':memory:' ? path : resolve(path);
    if (location !== ':memory:') mkdirSync(dirname(location), { recursive: true });
    const database = new DatabaseSync(location, { timeout: BUSY_TIMEOUT_MS });
    try {
      if (location !== ':memory:') database.exec('PRAGMA journal_mode = WAL');
      database.exec('PRAGMA synchronous = NORMAL');
      migrate(database);
    } catch (error) {
      database.close();
      throw new SDKError(`Could not open SQLite database at ${location}: ${(error as Error).message}`, 'LOUSHO_STORAGE_FAILED', {
        cause: error,
      });
    }
    return new Connection(location, database);
  }

  /** The open database; throws once {@link close} has been called. */
  get db(): SqlDatabase {
    if (!this.database) {
      throw new SDKError(`SqliteStore for ${this.path} is closed. Create a new SqliteStore to keep using it.`, 'LOUSHO_STORAGE_FAILED');
    }
    return this.database;
  }

  /** Run `work` in one write transaction (`BEGIN IMMEDIATE`), rolling back if it throws. */
  transaction<T>(work: () => T): T {
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }
}
