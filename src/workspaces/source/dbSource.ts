import type { AuditInput } from '../../improve/audit';
import type { SqlRow, SqlValue } from '../../storage/sqlite/driver';
import { isUniqueViolation, postgresSqlClient, sqliteSqlClient, type PgPool, type PostgresOptions, type SqlClient, type SqlStatements } from '../runtime/sql';
import { StaleRevisionError, unknownRevision } from './errors';
import { migrateWorkspaceSource } from './migrations/workspaceSource';
import { applyChanges, checkPath, checkTree, contentHash, listFiles, nextTree, revisionId, revisionMeta, type FileMap } from './revision';
import type { RevisionActor, RevisionId, RevisionKind, RevisionMeta, SourceRef, SourceWriteOptions, WorkspaceChanges, WorkspaceSource } from './types';

/** Options of {@link sqliteWorkspaceSource} and {@link postgresWorkspaceSource}. */
export interface DbSourceOptions {
  /** The project and workspace ids; default `default` and `workspace`. */
  ref?: Partial<SourceRef>;
  /** The files a new workspace starts with; ignored when the database already holds the workspace. */
  files?: Readonly<Record<string, string>>;
}

/** A workspace source over database rows: file rows per revision, one blob row per distinct content, a revision log keyed by `seq` and a head. */
export interface DbWorkspaceSource extends WorkspaceSource {
  /** Writes a new revision in one transaction and moves the head only if it still equals `expectedRevision`. */
  write(changes: WorkspaceChanges, options: SourceWriteOptions): Promise<RevisionMeta>;
  /** Closes the connection, or leaves a host-owned pool open. */
  close(): Promise<void>;
}

const WRITE_ATTEMPTS = 5;
const SCOPE = 'project_id = ? AND workspace_id = ?';
const FILE_CONTENT = 'FROM workspace_files f JOIN file_blobs b ON b.hash = f.hash WHERE f.project_id = ? AND f.workspace_id = ? AND f.revision = ?';

function scoped(ref: SourceRef, ...params: SqlValue[]): SqlValue[] {
  return [ref.projectId, ref.workspaceId, ...params];
}

async function headOf(db: SqlStatements, ref: SourceRef): Promise<RevisionId | undefined> {
  const rows = await db.query(`SELECT revision FROM workspace_heads WHERE ${SCOPE}`, scoped(ref));
  return rows[0] === undefined ? undefined : String(rows[0].revision);
}

async function requireHead(db: SqlStatements, ref: SourceRef): Promise<RevisionId> {
  const head = await headOf(db, ref);
  if (head === undefined) throw unknownRevision('head');
  return head;
}

async function knownRevision(db: SqlStatements, ref: SourceRef, revision: RevisionId): Promise<boolean> {
  if ((await headOf(db, ref)) === revision) return true;
  const rows = await db.query(`SELECT seq FROM workspace_revisions WHERE ${SCOPE} AND (revision = ? OR (seq = 1 AND parent = ?)) LIMIT 1`, scoped(ref, revision, revision));
  return rows.length > 0;
}

async function pinned(db: SqlStatements, ref: SourceRef, revision: RevisionId | undefined): Promise<RevisionId> {
  if (revision === undefined) return requireHead(db, ref);
  if (!(await knownRevision(db, ref, revision))) throw unknownRevision(revision);
  return revision;
}

async function filesAt(db: SqlStatements, ref: SourceRef, revision: RevisionId): Promise<FileMap> {
  const rows = await db.query(`SELECT f.path, b.content ${FILE_CONTENT}`, scoped(ref, revision));
  return new Map(rows.map((row) => [String(row.path), String(row.content)]));
}

async function pathsAt(db: SqlStatements, ref: SourceRef, revision: RevisionId): Promise<FileMap> {
  const rows = await db.query(`SELECT path FROM workspace_files WHERE ${SCOPE} AND revision = ?`, scoped(ref, revision));
  return new Map(rows.map((row) => [String(row.path), '']));
}

async function readAt(db: SqlStatements, ref: SourceRef, revision: RevisionId, path: string): Promise<string | undefined> {
  const rows = await db.query(`SELECT b.content ${FILE_CONTENT} AND f.path = ?`, scoped(ref, revision, path));
  return rows[0] === undefined ? undefined : String(rows[0].content);
}

async function insertTree(tx: SqlStatements, ref: SourceRef, revision: RevisionId, files: FileMap): Promise<void> {
  for (const [path, content] of files) {
    const hash = contentHash(content);
    await tx.execute('INSERT INTO file_blobs (hash, content) VALUES (?, ?) ON CONFLICT (hash) DO NOTHING', [hash, content]);
    await tx.execute(
      'INSERT INTO workspace_files (project_id, workspace_id, revision, path, hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT (project_id, workspace_id, revision, path) DO NOTHING',
      scoped(ref, revision, path, hash)
    );
  }
}

async function nextSeq(tx: SqlStatements, ref: SourceRef): Promise<number> {
  const rows = await tx.query(`SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM workspace_revisions WHERE ${SCOPE}`, scoped(ref));
  return Number(rows[0]?.next_seq);
}

async function insertRevision(tx: SqlStatements, ref: SourceRef, meta: RevisionMeta): Promise<void> {
  const audit = meta.audit === undefined ? null : JSON.stringify(meta.audit);
  await tx.execute(
    'INSERT INTO workspace_revisions (project_id, workspace_id, seq, revision, parent, created_at, "by", message, kind, audit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    scoped(ref, meta.seq, meta.revision, meta.parent ?? null, meta.createdAt, meta.by, meta.message, meta.kind, audit)
  );
}

async function moveHead(tx: SqlStatements, ref: SourceRef, from: RevisionId, to: RevisionId): Promise<void> {
  const moved = await tx.execute(`UPDATE workspace_heads SET revision = ? WHERE ${SCOPE} AND revision = ?`, [to, ref.projectId, ref.workspaceId, from]);
  if (moved === 0) throw new StaleRevisionError(from, (await headOf(tx, ref)) ?? from);
}

async function commit(tx: SqlStatements, ref: SourceRef, revision: RevisionId, files: FileMap, options: SourceWriteOptions): Promise<RevisionMeta> {
  await insertTree(tx, ref, revision, files);
  const meta = revisionMeta(await nextSeq(tx, ref), revision, options.expectedRevision, options);
  await insertRevision(tx, ref, meta);
  await moveHead(tx, ref, options.expectedRevision, revision);
  return meta;
}

async function writeOnce(client: SqlClient, ref: SourceRef, changes: WorkspaceChanges, options: SourceWriteOptions): Promise<RevisionMeta> {
  const head = await requireHead(client, ref);
  const next = nextTree(await filesAt(client, ref, head), head, changes, options);
  return client.transaction((tx) => commit(tx, ref, next.revision, next.files, options));
}

async function write(client: SqlClient, ref: SourceRef, changes: WorkspaceChanges, options: SourceWriteOptions): Promise<RevisionMeta> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await writeOnce(client, ref, changes, options);
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= WRITE_ATTEMPTS) throw error;
    }
  }
}

function toMeta(row: SqlRow): RevisionMeta {
  const meta: RevisionMeta = {
    seq: Number(row.seq),
    revision: String(row.revision),
    createdAt: String(row.created_at),
    by: String(row.by) as RevisionActor,
    message: String(row.message),
    kind: String(row.kind) as RevisionKind,
  };
  if (row.parent !== null && row.parent !== undefined) meta.parent = String(row.parent);
  if (row.audit !== null && row.audit !== undefined) meta.audit = JSON.parse(String(row.audit)) as AuditInput;
  return meta;
}

async function seed(client: SqlClient, ref: SourceRef, files: Readonly<Record<string, string>>): Promise<void> {
  const initial = applyChanges(new Map(), files);
  checkTree(initial);
  if ((await headOf(client, ref)) !== undefined) return;
  const revision = revisionId(initial);
  await client.transaction(async (tx) => {
    await insertTree(tx, ref, revision, initial);
    await tx.execute('INSERT INTO workspace_heads (project_id, workspace_id, revision) VALUES (?, ?, ?) ON CONFLICT (project_id, workspace_id) DO NOTHING', scoped(ref, revision));
  });
}

export async function dbSource(client: SqlClient, options: DbSourceOptions = {}): Promise<DbWorkspaceSource> {
  const ref: SourceRef = { projectId: options.ref?.projectId ?? 'default', workspaceId: options.ref?.workspaceId ?? 'workspace' };
  await migrateWorkspaceSource(client);
  await seed(client, ref, options.files ?? {});
  return {
    ref,
    revision: () => requireHead(client, ref),
    read: async (path, readOptions = {}) => readAt(client, ref, await pinned(client, ref, readOptions.revision), checkPath(path)),
    list: async (prefix, readOptions = {}) => listFiles(await pathsAt(client, ref, await pinned(client, ref, readOptions.revision)), prefix),
    history: async () => (await client.query(`SELECT * FROM workspace_revisions WHERE ${SCOPE} ORDER BY seq DESC`, scoped(ref))).map(toMeta),
    write: (changes, writeOptions) => write(client, ref, changes, writeOptions),
    close: () => client.close(),
  };
}

/** A database workspace source in one SQLite file (or `:memory:`), for tests and Forge-only; it creates its tables on open. */
export async function sqliteWorkspaceSource(path: string, options: DbSourceOptions = {}): Promise<DbWorkspaceSource> {
  const client = sqliteSqlClient(path);
  try {
    return await dbSource(client, options);
  } catch (error) {
    await client.close();
    throw error;
  }
}

/** A database workspace source in Postgres through a `pg` Pool the host owns; it creates its tables on open, and `close()` leaves the pool open unless `ownsPool` is set. */
export function postgresWorkspaceSource(pool: PgPool, options: DbSourceOptions & PostgresOptions = {}): Promise<DbWorkspaceSource> {
  return dbSource(postgresSqlClient(pool, options, () => pool.connect()), options);
}
