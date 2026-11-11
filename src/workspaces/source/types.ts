import type { AuditEntry, AuditInput } from '../../improve/audit';

/** Who writes a revision, in the audit log's actor format such as `person:<id>`. */
export type RevisionActor = AuditEntry['actor'];

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

/** One recorded write. History is keyed by `seq`: a rollback or an A to B to A edit records a new entry whose `revision` repeats an earlier one. */
export interface RevisionMeta {
  /** The write's place in this workspace's history, from 1, one more than the write before. */
  seq: number;
  /** The revision id of the tree after the write. */
  revision: RevisionId;
  /** The revision the write was made against; absent on the first one. */
  parent?: RevisionId;
  /** ISO time it was written. */
  createdAt: string;
  /** Who wrote it. */
  by: RevisionActor;
  /** One line about the change. */
  message: string;
  /** Why it was written. */
  kind: RevisionKind;
  /** The audit entry committed with the write, when the writer passed one. */
  audit?: AuditInput;
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
  by: RevisionActor;
  /** One line about the change. */
  message: string;
  /** Why it is written; defaults to `authoring`. */
  kind?: RevisionKind;
  /** The audit entry to commit together with the revision. */
  audit?: AuditInput;
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
  /** Recorded writes, newest first (highest `seq` first). */
  history(): Promise<RevisionMeta[]>;
  /** Writes a new revision, all files or none; refuses a stale `expectedRevision` (`StaleRevisionError`) and changes that leave the tree as it is (`NoChangeError`). A rollback is a new write that restores old content, never a move of the head. Only WorkspaceRepo calls it. */
  write?(changes: WorkspaceChanges, options: SourceWriteOptions): Promise<RevisionMeta>;
}
