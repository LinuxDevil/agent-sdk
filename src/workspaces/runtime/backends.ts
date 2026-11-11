import { join } from 'node:path';
import { fileStore } from '../../storage/fileStore';
import { SqliteStore } from '../../storage/sqlite/SqliteStore';
import { fileRunLedger } from './fileLedger';
import { migrateHostTables, postgresSqlClient, sqliteSqlClient, type PgQueryable, type PostgresOptions, type SqlClient } from './sql';
import { sqlCheckpointStore, sqlRunLedger, sqlSessionStore } from './sqlBackend';
import type { BackendParts, HostBackend } from './stores';

/** Plain JSON files under `dir`: the `fileStore` layout plus `workspaces/runs` and `workspaces/events`. For development and tests. */
export function fileHostBackend(dir: string): HostBackend {
  const parts: BackendParts = { agent: fileStore(dir), ledger: fileRunLedger(join(dir, 'workspaces')), close: async () => undefined };
  return parts;
}

/** One SQLite file: the existing `SqliteStore` for sessions and checkpoints, plus the run tables. For tests and Forge-only. */
export async function sqliteHostBackend(path: string): Promise<HostBackend> {
  const agent = new SqliteStore(path);
  const client = sqliteSqlClient(path);
  await migrateHostTables(client);
  const parts: BackendParts = {
    agent,
    ledger: sqlRunLedger(client),
    async close() {
      agent.close();
      await client.close();
    },
  };
  return parts;
}

export async function sqlHostBackend(client: SqlClient): Promise<HostBackend> {
  await migrateHostTables(client);
  const parts: BackendParts = {
    agent: { sessions: sqlSessionStore(client), checkpoints: sqlCheckpointStore(client) },
    ledger: sqlRunLedger(client),
    close: () => client.close(),
  };
  return parts;
}

/** Postgres through a `pg` Pool or Client the host owns; `close()` leaves the pool open unless `ownsPool` is set. */
export function postgresHostBackend(pool: PgQueryable, options: PostgresOptions = {}): Promise<HostBackend> {
  return sqlHostBackend(postgresSqlClient(pool, options));
}
