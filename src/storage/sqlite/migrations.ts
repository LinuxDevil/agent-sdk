import type { SqlDatabase } from './driver';
import { SDKError } from '../../execution/errors';

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
  // LOU-W6.2: cross-session memory items, one JSON array per scope key (the
  // same shape `fileMemory` writes). A new table, so older files just gain it.
  `
  CREATE TABLE memory_items (
    scope_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // N15: semantic memory. One row per item with its embedding (little-endian
  // Float32Array bytes, unit length) and the id of the embedder that made it.
  `
  CREATE TABLE memory_vectors (
    scope_key TEXT NOT NULL,
    id TEXT NOT NULL,
    text TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL,
    embedder TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    PRIMARY KEY (scope_key, id)
  );
  CREATE INDEX memory_vectors_created ON memory_vectors (scope_key, created_at);
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
      throw new SDKError(
        `Database schema version ${current} is newer than this library supports (${target}). ` +
          'Upgrade @lousho/build-ai-agent.',
        'LOUSHO_STORAGE_FAILED'
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
