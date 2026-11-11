import { unknownRevision } from './errors';
import { applyChanges, checkPath, checkTree, listFiles, nextTree, revisionId, revisionMeta, type FileMap } from './revision';
import type { RevisionId, RevisionMeta, SourceReadOptions, SourceRef, SourceWriteOptions, WorkspaceChanges, WorkspaceSource } from './types';

/** Options of {@link memorySource}. */
export interface MemorySourceOptions {
  /** The project and workspace ids; default `default` and `workspace`. */
  ref?: Partial<SourceRef>;
}

/** A workspace source held in memory, one file map per revision, for tests and hosts with no filesystem. */
export function memorySource(files: Readonly<Record<string, string>>, options: MemorySourceOptions = {}): WorkspaceSource {
  const ref: SourceRef = { projectId: options.ref?.projectId ?? 'default', workspaceId: options.ref?.workspaceId ?? 'workspace' };
  const initial = applyChanges(new Map(), files);
  checkTree(initial);
  const snapshots = new Map<RevisionId, FileMap>();
  const log: RevisionMeta[] = [];
  let head = revisionId(initial);
  snapshots.set(head, initial);

  function at(revision: RevisionId | undefined): FileMap {
    const snapshot = snapshots.get(revision ?? head);
    if (!snapshot) throw unknownRevision(revision ?? head);
    return snapshot;
  }

  return {
    ref,
    revision: async () => head,
    read: async (path: string, readOptions: SourceReadOptions = {}) => at(readOptions.revision).get(checkPath(path)),
    list: async (prefix: string, readOptions: SourceReadOptions = {}) => listFiles(at(readOptions.revision), prefix),
    history: async () => [...log].reverse(),
    write: async (changes: WorkspaceChanges, writeOptions: SourceWriteOptions) => {
      const next = nextTree(at(head), head, changes, writeOptions);
      const meta = revisionMeta(log.length + 1, next.revision, head, writeOptions);
      snapshots.set(meta.revision, next.files);
      log.push(meta);
      head = meta.revision;
      return meta;
    },
  };
}
