import type { WorkspaceTree } from '../contracts/baseHarness';
import type { RevisionId, SourceReadOptions, WorkspaceSource } from './types';

/** A whole workspace read at one pinned revision. */
export interface SourceTree {
  /** The revision that was read. */
  revision: RevisionId;
  /** Every file's text keyed by path, ready for `validateWorkspace`. */
  tree: Readonly<Record<string, string>> & WorkspaceTree;
}

/** Reads every file of `source` at one revision (default: the current one) into a `WorkspaceTree`. */
export async function readSourceTree(source: WorkspaceSource, options: SourceReadOptions = {}): Promise<SourceTree> {
  const revision = options.revision ?? (await source.revision());
  const tree: Record<string, string> = {};
  for (const path of await source.list('', { revision })) {
    const text = await source.read(path, { revision });
    if (text !== undefined) tree[path] = text;
  }
  return { revision, tree };
}
