/**
 * Which workspace the client is looking at (W04a). React-free: both the
 * `WorkspacesProvider` and `RuntimeClient.fetch`/`subscribeJson` read it
 * synchronously on every call.
 *
 * The active workspace comes from the URL first - `#/w/<ws>/…` names it
 * explicitly (PLAN §19.6) - and falls back to Studio's launch workspace,
 * which `setLaunchWorkspace` records once `GET /workspaces` answers.
 * Before that answer (or on a `#/w/<bad>/…` hash the id pattern rejects)
 * there is no active id and requests simply omit the header, which the
 * server resolves to the launch workspace anyway.
 */
import { WORKSPACE_ID_RE } from '../../shared/workspace';
import { parseHash } from '../router/router';

/** Studio's launch workspace id, set once by `WorkspacesProvider` from `GET /workspaces`. */
let launchId: string | undefined;

/**
 * `#/w/<ws>/…` → `<ws>` (URI-decoded) when it matches `WORKSPACE_ID_RE`;
 * anything else - no `/w/` prefix, a missing or malformed id - →
 * `undefined`.
 */
export function workspaceFromHash(hash: string): string | undefined {
  const parts = parseHash(hash).path.split('/').filter(Boolean);
  if (parts[0] !== 'w') return undefined;
  const raw = parts[1];
  if (raw === undefined) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return WORKSPACE_ID_RE.test(id) ? id : undefined;
}

/** Records the launch workspace id (`GET /workspaces`' `defaultId`); called once by `WorkspacesProvider`. */
export function setLaunchWorkspace(id: string): void {
  launchId = id;
}

/**
 * The workspace requests should target right now: the URL's `#/w/<ws>/…`
 * id when present and valid, else the launch workspace, else `undefined`
 * (before `GET /workspaces` answered - the server then applies its own
 * launch default, so omitting the header is correct).
 */
export function activeWorkspace(): string | undefined {
  if (typeof window === 'undefined') return launchId;
  return workspaceFromHash(window.location.hash) ?? launchId;
}
