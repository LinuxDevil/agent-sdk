import type { SqlClient, SqlStatements } from '../../runtime/sql';

const PG_MIGRATION_LOCK = 'SELECT pg_advisory_xact_lock(7311701)';

const V1 = [
  'CREATE TABLE IF NOT EXISTS file_blobs (hash TEXT PRIMARY KEY, content TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS workspace_files (
     project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, revision TEXT NOT NULL, path TEXT NOT NULL,
     hash TEXT NOT NULL REFERENCES file_blobs (hash),
     PRIMARY KEY (project_id, workspace_id, revision, path))`,
  `CREATE TABLE IF NOT EXISTS workspace_revisions (
     project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, seq INTEGER NOT NULL, revision TEXT NOT NULL, parent TEXT,
     created_at TEXT NOT NULL, "by" TEXT NOT NULL, message TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('authoring', 'improvement', 'rollback', 'import')), audit TEXT,
     PRIMARY KEY (project_id, workspace_id, seq))`,
  'CREATE INDEX IF NOT EXISTS workspace_revisions_revision ON workspace_revisions (project_id, workspace_id, revision)',
  'CREATE TABLE IF NOT EXISTS workspace_heads (project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY (project_id, workspace_id))',
];

async function createTables(db: SqlStatements): Promise<void> {
  for (const statement of V1) await db.execute(statement);
}

type MigrationDialect = 'sqlite' | 'postgres';

export async function migrateWorkspaceSource(client: SqlClient, dialect: MigrationDialect): Promise<void> {
  if (dialect === 'sqlite') return createTables(client);
  await client.transaction(async (tx) => {
    await tx.query(PG_MIGRATION_LOCK);
    await createTables(tx);
  });
}
