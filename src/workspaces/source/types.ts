/** A revision id: the sha256 hex of the tree's sorted `(path, contentHash)` list, so the same files give the same id on every source. */
export type RevisionId = string;

/** Why a revision was written. */
export type RevisionKind = 'authoring' | 'improvement' | 'rollback' | 'import';

/** Which workspace a source holds; carried even when the host has one project. */
export interface SourceRef {
  /** The project that holds the workspace. */
  projectId: string;
  /** The workspace id. */
  workspaceId: string;
}

/** One recorded revision. */
export interface RevisionMeta {
  /** The revision id. */
  revision: RevisionId;
  /** The revision the write was made against; absent on the first one. */
  parent?: RevisionId;
  /** ISO time it was written. */
  createdAt: string;
  /** Who wrote it. */
  by: string;
  /** One line about the change. */
  message: string;
  /** Why it was written. */
  kind: RevisionKind;
}

/** Options of a read or a list. */
export interface SourceReadOptions {
  /** The revision to read; defaults to the current one. */
  revision?: RevisionId;
}

/** File changes keyed by workspace-relative path: a string is the new content, `null` deletes the file. */
export type WorkspaceChanges = Readonly<Record<string, string | null>>;

/** Options of a write. */
export interface SourceWriteOptions {
  /** The revision the changes were made against; a different current revision refuses the write. */
  expectedRevision: RevisionId;
  /** Who writes. */
  by: string;
  /** One line about the change. */
  message: string;
  /** Why it is written; defaults to `authoring`. */
  kind?: RevisionKind;
}

/** Where a workspace's files live: a folder, memory or database rows. Every revision is immutable. */
export interface WorkspaceSource {
  /** The project and workspace this source holds. */
  readonly ref: SourceRef;
  /** The current revision. */
  revision(): Promise<RevisionId>;
  /** A file's text at a revision, or `undefined` when the file does not exist there. */
  read(path: string, options?: SourceReadOptions): Promise<string | undefined>;
  /** The sorted file paths at a revision under `prefix` (a folder path, or `''` for every file). */
  list(prefix: string, options?: SourceReadOptions): Promise<string[]>;
  /** Recorded revisions, newest first. */
  history(): Promise<RevisionMeta[]>;
  /** Writes a new revision; refuses a stale `expectedRevision` with `StaleRevisionError`. Only WorkspaceRepo calls it. */
  write?(changes: WorkspaceChanges, options: SourceWriteOptions): Promise<RevisionMeta>;
}
