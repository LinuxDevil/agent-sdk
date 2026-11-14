import type { WorkspaceListItem } from '../../shared/wireTypes';
import { workspaceFromHash } from './activeWorkspace';

/** 'All workspaces' when `id` is undefined; else the list item's `name`; else the id itself. */
export function workspaceLabel(id: string | undefined, list: readonly WorkspaceListItem[] | undefined): string {
  if (id === undefined) return 'All workspaces';
  return list?.find((w) => w.id === id)?.name ?? id;
}

/**
 * The workspace the switcher should show as current: the `#/w/<ws>/…` URL's
 * workspace, or `undefined` on every other route - the all-workspaces view.
 * (W04a's `workspaceFromHash` already falls back to nothing for malformed
 * ids; the launch workspace is a request default, not a selection.)
 */
export function switcherSelection(hash: string): string | undefined {
  return workspaceFromHash(hash);
}
