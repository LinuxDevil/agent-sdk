import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadDatabaseSync, type SqlDatabase } from './driver';
import { migrate } from './migrations';
import { SDKError } from '../../execution/errors';

/**
 * Milliseconds the driver itself waits (blocking the whole event loop, since
 * `node:sqlite` is synchronous) for another process's lock. Kept short; the
 * longer wait is {@link Connection.transactionAsync}'s backoff, which yields.
 */
const BUSY_TIMEOUT_MS = 50;

/** Attempts and first backoff of {@link Connection.transactionAsync}; the backoff doubles (about 5 s in all). */
const ASYNC_RETRY_ATTEMPTS = 10;
const ASYNC_RETRY_BASE_MS = 10;
const ASYNC_RETRY_MAX_MS = 1000;

/** SQLITE_BUSY (5) and SQLITE_LOCKED (6), as `node:sqlite` reports them (`errcode`) or in the message. */
function isBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { errcode, message } = error as { errcode?: unknown; message?: unknown };
  if (errcode === 5 || errcode === 6) return true;
  return typeof message === 'string' && /database (table )?is locked|SQLITE_BUSY/i.test(message);
}

function busyError(path: string, cause: unknown): SDKError {
  return new SDKError(`SQLite database ${path} is locked by another connection or process; retry the call.`, 'LOUSHO_STORAGE_BUSY', { cause });
}

/** Map a lock-contention failure to the coded {@link SDKError}; rethrow anything else untouched. */
function mapBusy(path: string, error: unknown): never {
  throw isBusyError(error) ? busyError(path, error) : error;
}

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

  /**
   * Run `work` in one write transaction (`BEGIN IMMEDIATE`), rolling back if
   * it throws. Lock contention that outlasts the short busy timeout throws
   * `LOUSHO_STORAGE_BUSY` (retry it, or use {@link transactionAsync}).
   */
  transaction<T>(work: () => T): T {
    const db = this.db;
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      return mapBusy(this.path, error);
    }
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // the transaction is already gone (e.g. COMMIT itself failed); keep the original error
      }
      return mapBusy(this.path, error);
    }
  }

  /**
   * Like {@link transaction}, but when the database is locked it waits with
   * exponential backoff on the event loop (timers keep firing) instead of
   * blocking it, and gives up with `LOUSHO_STORAGE_BUSY` after about 5 s.
   * `work` re-runs on each attempt, so it must be safe to repeat.
   */
  async transactionAsync<T>(work: () => T): Promise<T> {
    let delay = ASYNC_RETRY_BASE_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        return this.transaction(work);
      } catch (error) {
        if (!(error instanceof SDKError) || error.code !== 'LOUSHO_STORAGE_BUSY' || attempt >= ASYNC_RETRY_ATTEMPTS) throw error;
        await new Promise<void>((done) => setTimeout(done, delay));
        delay = Math.min(delay * 2, ASYNC_RETRY_MAX_MS);
      }
    }
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }
}
