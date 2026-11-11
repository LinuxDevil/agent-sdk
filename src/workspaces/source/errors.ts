import { SDKError } from '../../utils/sdkError';
import { brandClass } from '../../utils/brand';
import type { RevisionId } from './types';

/** A write named an `expectedRevision` that is no longer the current revision (`LOUSHO_WORKSPACE_STALE_REVISION`). */
export class StaleRevisionError extends SDKError {
  /** The revision the write was made against. */
  readonly expectedRevision: RevisionId;
  /** The current revision. */
  readonly currentRevision: RevisionId;

  constructor(expectedRevision: RevisionId, currentRevision: RevisionId) {
    super(`The workspace changed: the write was made against revision ${expectedRevision}, but the current revision is ${currentRevision}.`, 'LOUSHO_WORKSPACE_STALE_REVISION');
    this.name = 'StaleRevisionError';
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}
brandClass(StaleRevisionError, 'StaleRevisionError');

/** A write whose changes leave the tree exactly as it is; no revision is recorded (`LOUSHO_WORKSPACE_NO_CHANGE`). */
export class NoChangeError extends SDKError {
  /** The current revision, which the write would have repeated. */
  readonly revision: RevisionId;

  constructor(revision: RevisionId) {
    super(`The write changes nothing: the tree would stay at revision ${revision}.`, 'LOUSHO_WORKSPACE_NO_CHANGE');
    this.name = 'NoChangeError';
    this.revision = revision;
  }
}
brandClass(NoChangeError, 'NoChangeError');

export function invalidPath(path: string, why: string): SDKError {
  return new SDKError(`Workspace path '${path}' ${why}.`, 'LOUSHO_WORKSPACE_PATH_INVALID');
}

export function unknownRevision(revision: RevisionId): SDKError {
  return new SDKError(`Workspace revision ${revision} is not known to this source, or its snapshot was pruned.`, 'LOUSHO_WORKSPACE_REVISION_UNKNOWN');
}

export function sourceLimit(what: string): SDKError {
  return new SDKError(`The workspace source refused to read: ${what}.`, 'LOUSHO_WORKSPACE_SOURCE_LIMIT');
}

export function unsupportedContent(path: string): SDKError {
  return new SDKError(`Workspace file '${path}' contains a NUL character, which a database workspace source cannot store.`, 'LOUSHO_WORKSPACE_CONTENT_UNSUPPORTED');
}

export function corruptSource(what: string, cause?: unknown): SDKError {
  return new SDKError(`The workspace folder's revision records are damaged: ${what}.`, 'LOUSHO_WORKSPACE_SOURCE_CORRUPT', cause === undefined ? {} : { cause });
}
