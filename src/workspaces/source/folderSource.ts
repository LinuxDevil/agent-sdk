import { basename } from 'node:path';
import { unknownRevision } from './errors';
import { checkWritable, readFolderTree, readText, realRoot, removeFile, writeAtomic, type FolderLimits } from './folderFs';
import { checkPath, listFiles, nextTree, revisionId, revisionMeta, SOURCE_DIR, type FileMap } from './revision';
import type { RevisionId, RevisionMeta, SourceReadOptions, SourceRef, SourceWriteOptions, WorkspaceChanges, WorkspaceSource } from './types';

/** Options of {@link folderSource}. */
export interface FolderSourceOptions {
  /** The project and workspace ids; default `default` and the folder's name. */
  ref?: Partial<SourceRef>;
  /** How many recent revisions keep a snapshot, so they stay readable; default 50. */
  keep?: number;
  /** The largest file it reads, in bytes; default 1 MiB. */
  maxFileBytes?: number;
  /** The most files it lists; default 5000. */
  maxFiles?: number;
  /** The most bytes it reads for one whole tree or snapshot; default 32 MiB. */
  maxTreeBytes?: number;
}

const REVISIONS_DIR = `${SOURCE_DIR}/revisions`;
const INDEX_PATH = `${REVISIONS_DIR}/index.json`;
const JOURNAL_PATH = `${REVISIONS_DIR}/pending.json`;
const REVISION_ID = /^[0-9a-f]{64}$/;

interface Journal {
  meta: RevisionMeta;
  changes: Record<string, string | null>;
}

function snapshotPath(revision: RevisionId): string {
  return `${REVISIONS_DIR}/${revision}.json`;
}

function parseIndex(text: string | undefined): RevisionMeta[] {
  return text === undefined ? [] : (JSON.parse(text) as RevisionMeta[]);
}

function keptRevisions(log: readonly RevisionMeta[], keep: number): Set<RevisionId> {
  return new Set(log.slice(-keep).map((meta) => meta.revision));
}

/** A workspace source over a folder. Its writer commits all files or none through a journal it finishes on next access after a crash, and keeps revision metadata and recent snapshots in `<dir>/.lousho/revisions/`. */
export function folderSource(dir: string, options: FolderSourceOptions = {}): WorkspaceSource {
  const ref: SourceRef = { projectId: options.ref?.projectId ?? 'default', workspaceId: options.ref?.workspaceId ?? basename(dir) };
  const keep = Math.max(1, options.keep ?? 50);
  const limits: FolderLimits = { maxFileBytes: options.maxFileBytes ?? 1024 * 1024, maxFiles: options.maxFiles ?? 5000, maxTreeBytes: options.maxTreeBytes ?? 32 * 1024 * 1024 };
  let rootPromise: Promise<string> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const root = (): Promise<string> => (rootPromise ??= realRoot(dir));
  let last: { revision: RevisionId; files: FileMap } | undefined;
  const readMeta = async (path: string): Promise<string | undefined> => readText(await root(), path, limits.maxTreeBytes);

  async function current(): Promise<FileMap> {
    const files = await readFolderTree(await root(), limits);
    last = { revision: revisionId(files), files };
    return files;
  }

  async function stored(revision: RevisionId): Promise<FileMap | undefined> {
    const text = await readMeta(snapshotPath(revision));
    return text === undefined ? undefined : new Map(Object.entries(JSON.parse(text) as Record<string, string>));
  }

  async function snapshot(revision: RevisionId): Promise<FileMap> {
    if (!REVISION_ID.test(revision)) throw unknownRevision(revision);
    if (last?.revision === revision) return last.files;
    const files = (await stored(revision)) ?? (await current());
    if (revisionId(files) !== revision) throw unknownRevision(revision);
    last = { revision, files };
    return files;
  }

  async function saveSnapshot(dirRoot: string, revision: RevisionId, files: FileMap): Promise<void> {
    if ((await readMeta(snapshotPath(revision))) === undefined) await writeAtomic(dirRoot, snapshotPath(revision), JSON.stringify(Object.fromEntries(files)));
  }

  async function readIndex(): Promise<RevisionMeta[]> {
    return parseIndex(await readMeta(INDEX_PATH));
  }

  async function prune(dirRoot: string, log: readonly RevisionMeta[]): Promise<void> {
    if (log.length <= keep) return;
    const kept = keptRevisions(log, keep);
    const dropped = log[log.length - keep - 1];
    for (const revision of [dropped.revision, dropped.parent]) if (revision !== undefined && !kept.has(revision)) await removeFile(dirRoot, snapshotPath(revision));
  }

  async function applyToDisk(dirRoot: string, changes: WorkspaceChanges): Promise<void> {
    for (const [path, content] of Object.entries(changes)) {
      checkPath(path);
      if (content === null) await removeFile(dirRoot, path);
      else await writeAtomic(dirRoot, path, content);
    }
  }

  async function finish(dirRoot: string, journal: Journal): Promise<void> {
    await applyToDisk(dirRoot, journal.changes);
    const before = await readIndex();
    const log = before.some((meta) => meta.seq === journal.meta.seq) ? before : [...before, journal.meta];
    if (log !== before) await writeAtomic(dirRoot, INDEX_PATH, JSON.stringify(log));
    await removeFile(dirRoot, JOURNAL_PATH);
    await prune(dirRoot, log);
  }

  async function recover(): Promise<void> {
    const pending = await readMeta(JOURNAL_PATH);
    if (pending !== undefined) await finish(await root(), JSON.parse(pending) as Journal);
  }

  async function write(changes: WorkspaceChanges, writeOptions: SourceWriteOptions): Promise<RevisionMeta> {
    const dirRoot = await root();
    const files = await current();
    const head = revisionId(files);
    const next = nextTree(files, head, changes, writeOptions);
    for (const path of Object.keys(changes)) await checkWritable(dirRoot, path);
    const meta = revisionMeta(((await readIndex()).at(-1)?.seq ?? 0) + 1, next.revision, head, writeOptions);
    await saveSnapshot(dirRoot, head, files);
    await saveSnapshot(dirRoot, meta.revision, next.files);
    const journal: Journal = { meta, changes: { ...changes } };
    await writeAtomic(dirRoot, JOURNAL_PATH, JSON.stringify(journal));
    await finish(dirRoot, journal);
    return meta;
  }

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      await recover();
      return work();
    });
    queue = result.catch(() => undefined);
    return result;
  }

  return {
    ref,
    revision: () => serial(async () => revisionId(await current())),
    read: (path: string, readOptions: SourceReadOptions = {}) =>
      serial(async () => {
        checkPath(path);
        if (readOptions.revision === undefined) return readText(await root(), path, limits.maxFileBytes);
        return (await snapshot(readOptions.revision)).get(path);
      }),
    list: (prefix: string, readOptions: SourceReadOptions = {}) =>
      serial(async () => listFiles(readOptions.revision === undefined ? await current() : await snapshot(readOptions.revision), prefix)),
    history: () => serial(async () => (await readIndex()).reverse()),
    write: (changes: WorkspaceChanges, writeOptions: SourceWriteOptions) => serial(() => write(changes, writeOptions)),
  };
}
