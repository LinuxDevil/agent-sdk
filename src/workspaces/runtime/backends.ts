import { join } from 'node:path';
import { fileStore } from '../../storage/fileStore';
import { SqliteStore } from '../../storage/sqlite/SqliteStore';
import { fileRunLedger } from './fileLedger';
import { migrateHostTables, postgresSqlClient, sqliteSqlClient, type PgQueryable, type SqlClient } from './sql';
import { sqlCheckpointStore, sqlRunLedger, sqlSessionStore } from './sqlBackend';
import type { HostBackend } from './stores';

/** A {@link HostBackend} that can release what it opened. */
export interface ClosableHostBackend extends HostBackend {
  /** Closes the connections the backend opened. */
  close(): Promise<void>;
}

/** Plain JSON files under `dir`: the `fileStore` layout plus `runs/` and `events/`. For development and tests. */
export function fileHostBackend(dir: string): ClosableHostBackend {
  const agent = fileStore(dir);
  return { agent, ledger: fileRunLedger(join(dir, 'workspaces')), close: async () => undefined };
}

/** One SQLite file: the existing `SqliteStore` for sessions and checkpoints, plus the run tables. For tests and Forge-only. */
export async function sqliteHostBackend(path: string): Promise<ClosableHostBackend> {
  const agent = new SqliteStore(path);
  const client = sqliteSqlClient(path);
  await migrateHostTables(client);
  return {
    agent,
    ledger: sqlRunLedger(client),
    async close() {
      agent.close();
      await client.close();
    },
  };
}

/** Any {@link SqlClient}: every store is a table written through it (Postgres, or SQLite with the same tables). */
export async function sqlHostBackend(client: SqlClient): Promise<ClosableHostBackend> {
  await migrateHostTables(client);
  return { agent: { sessions: sqlSessionStore(client), checkpoints: sqlCheckpointStore(client) }, ledger: sqlRunLedger(client), close: () => client.close() };
}

/** Postgres through a `pg` Pool or Client the host owns: every store is a table written with the {@link SqlClient}. */
export function postgresHostBackend(pool: PgQueryable): Promise<ClosableHostBackend> {
  return sqlHostBackend(postgresSqlClient(pool));
}
