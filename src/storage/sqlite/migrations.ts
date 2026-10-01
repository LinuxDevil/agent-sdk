import type { SqlDatabase } from './driver';

/**
 * Forward-only schema migrations. `MIGRATIONS[n]` upgrades a database from
 * `user_version` n to n + 1. Append new entries; never edit shipped ones.
 *
 * Payloads are opaque JSON text so new fields on sessions, checkpoints and
 * approval snapshots round-trip without schema changes.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_updated_at ON sessions (updated_at);
  CREATE TABLE checkpoints (
    session_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX checkpoints_updated_at ON checkpoints (updated_at);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX approvals_resolved_at ON approvals (resolved_at);
  `,
  // LOU-D43: bounded per-session checkpoint history. A new table, so a file
  // written by an earlier release just gains it on open.
  `
  CREATE TABLE checkpoint_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    step INTEGER NOT NULL,
    status TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX checkpoint_history_session ON checkpoint_history (session_id, id);
  CREATE INDEX checkpoint_history_saved_at ON checkpoint_history (saved_at);
  `,
];

function readVersion(db: SqlDatabase): number {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

/**
 * Bring `db` up to `migrations.length`, in one transaction. The version is
 * re-read after the write lock is taken, so two processes opening a fresh
 * file at once migrate it exactly once. A database from a newer release is
 * refused rather than guessed at.
 *
 * @returns the schema version after migrating
 */
export function migrate(db: SqlDatabase, migrations: readonly string[] = MIGRATIONS): number {
  const target = migrations.length;
  if (readVersion(db) === target) return target;
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readVersion(db);
    if (current > target) {
      throw new Error(
        `Database schema version ${current} is newer than this library supports (${target}). ` +
          'Upgrade @loushy/build-ai-agent.'
      );
    }
    for (let version = current; version < target; version++) {
      db.exec(migrations[version]);
    }
    db.exec(`PRAGMA user_version = ${target}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return target;
}
