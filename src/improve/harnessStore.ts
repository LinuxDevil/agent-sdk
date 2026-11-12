import { appendAudit, readAudit, verifyAudit, type AuditEntry, type AuditInput } from './audit';
import type { HarnessRevision } from './revisions';
import type { Harness } from './types';

/** What a store holds now: the harness and the skills that must never be rewritten. */
export interface HarnessStoreState {
  /** The instructions and skills. */
  harness: Harness;
  /** Skills that are hashed but never rewritten or deleted. */
  readOnly: string[];
}

/** One commit a store makes: the next harness, the revision it replaces, and the audit entry written with it. */
export interface HarnessCommit {
  /** `harnessHash` of the harness being replaced. */
  from: string;
  /** Whether this is an applied proposal or a rollback. */
  action: 'apply' | 'rollback';
  /** The audit entry to commit with the files; the store sets `to`, and for `apply` replaces `reason` with `Applied <written files joined by ', '>.` */
  audit: AuditInput;
}

/** A hash-chained audit log, wherever it lives. */
export interface AuditLog {
  /** Appends one entry; the log fills in `seq`, `at`, `prev` and `hash`. */
  append(entry: AuditInput): Promise<AuditEntry>;
  /** Every entry, oldest first. */
  read(): Promise<AuditEntry[]>;
  /** The first broken `seq`, or `undefined` when the chain is intact. */
  verify(): Promise<number | undefined>;
}

/** Where one improvement target's harness lives: an agent folder, or files inside a workspace. M4's apply and rollback run over it. */
export interface HarnessStore {
  /** A stable name for messages, such as the folder path or `marketing:agents/script-maker`. */
  readonly key: string;
  /** The current harness. */
  read(): Promise<HarnessStoreState>;
  /** Saved revisions, newest first, for rollback. */
  revisions(): Promise<HarnessRevision[]>;
  /** Writes `next`, records one audit entry with it, and returns the new harness hash and the files written. Refuses as stale (field `base`) when the target changed under it. */
  commit(next: Harness, commit: HarnessCommit): Promise<{ to: string; written: string[] }>;
  /** Runs `task` so no other commit on this store interleaves. */
  withLock<T>(task: () => Promise<T>): Promise<T>;
  /** The audit log refusals are written to. */
  readonly audit: AuditLog;
}

/** The audit log at `<dir>/.lousho/audit.jsonl`, the one `appendAudit` writes. */
export function folderAuditLog(dir: string): AuditLog {
  return {
    append: (entry) => appendAudit(dir, entry),
    read: async () => readAudit(dir),
    verify: async () => verifyAudit(dir),
  };
}
