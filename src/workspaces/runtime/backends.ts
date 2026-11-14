import { join } from 'node:path';
import { fileStore } from '../../storage/fileStore';
import { fileRunLedger } from './fileLedger';
import { migrateHostTables, postgresSqlClient, sqliteClientOnly, sqliteSqlClient, type PgQueryable, type PostgresOptions, type SqlClient } from './sql';
import { sqlCheckpointStore, sqlRunLedger, sqlSessionStore } from './sqlBackend';
import type { BackendParts, HostBackend } from './stores';

/** Plain JSON files under `dir`: the `fileStore` layout plus `workspaces/runs` and `workspaces/events`. For development and tests. */
export function fileHostBackend(dir: string): HostBackend {
  const parts: BackendParts = { agent: fileStore(dir), ledger: fileRunLedger(join(dir, 'workspaces')), close: async () => undefined };
  return parts;
}

/** One SQLite file holding the `ws_*` tables for threads, checkpoints, runs and events, the same layout as Postgres. For tests and Forge-only. Given a path it opens and owns one connection; given a `sqliteSqlClient` it uses that shared connection and leaves it open, so the stores and a `sqliteWorkspaceSource` on the same file use one connection. */
export async function sqliteHostBackend(db: string | SqlClient): Promise<HostBackend> {
  if (typeof db !== 'string') return sqlHostBackend(sqliteClientOnly(db, 'sqliteHostBackend'), async () => undefined);
  const client = sqliteSqlClient(db);
  try {
    return await sqlHostBackend(client, () => client.close());
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function sqlHostBackend(client: SqlClient, close: () => Promise<void>): Promise<HostBackend> {
  await migrateHostTables(client);
  const parts: BackendParts = {
    agent: { sessions: sqlSessionStore(client), checkpoints: sqlCheckpointStore(client) },
    ledger: sqlRunLedger(client),
    close,
  };
  return parts;
}

/** Postgres through a `pg` Pool or Client the host owns; `close()` leaves the pool open unless `ownsPool` is set. */
export function postgresHostBackend(pool: PgQueryable, options: PostgresOptions = {}): Promise<HostBackend> {
  const client = postgresSqlClient(pool, options);
  return sqlHostBackend(client, () => client.close());
}
