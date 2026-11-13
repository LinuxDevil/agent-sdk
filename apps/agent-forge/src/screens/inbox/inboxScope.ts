/**
 * Which inbox `#/inbox` vs `#/w/<ws>/inbox` shows (W09b, PLAN §19.6): the
 * bare route aggregates every workspace, the `/w/` one is scoped to it.
 * React-free so routes and tests can read it straight from the hash.
 */
import { parseHash } from '../../router/router';
import { workspaceFromHash } from '../../workspace/activeWorkspace';

export type InboxScope = { kind: 'all' } | { kind: 'workspace'; workspaceId: string };

/**
 * The inbox scope a hash asks for: `#/w/<ws>/inbox` (a valid workspace id,
 * exactly that path) scopes to it; `#/inbox` and anything else is the
 * all-workspaces view.
 */
export function inboxScopeFromHash(hash: string): InboxScope {
  const { path } = parseHash(hash);
  const parts = path.split('/').filter(Boolean);
  const ws = workspaceFromHash(hash);
  if (parts[0] === 'w' && parts[2] === 'inbox' && parts.length === 3 && ws !== undefined) {
    return { kind: 'workspace', workspaceId: ws };
  }
  return { kind: 'all' };
}

/** `/w/<ws>/inbox` for one workspace's inbox, `/inbox` (every workspace) when `ws` is undefined. */
export function inboxPath(ws?: string): string {
  return ws === undefined ? '/inbox' : `/w/${encodeURIComponent(ws)}/inbox`;
}
