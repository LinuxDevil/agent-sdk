/**
 * The code-agent screen's URL helpers (W08b): `#/w/<ws>/code-agents/<path>`
 * where `<path>` is the `CodeAgentItem.id` - the agent directory's POSIX
 * path relative to the workspace root - `encodeURIComponent`'d into ONE
 * segment (`agents%2Fsupport` decodes back to `agents/support`;
 * `matchRoute` decodes once). The bare `#/code-agents/<path>` row is the
 * pre-W08b link and redirects into the launch workspace.
 */
import { matchRoute } from '../../router/router';
import { WORKSPACE_ID_RE } from '../../../shared/workspace';

/**
 * The hash path of one code agent in one workspace:
 * `/w/<ws>/code-agents/<encodeURIComponent(path)>`.
 */
export function codeAgentPath(workspaceId: string, path: string): string {
  return `/w/${encodeURIComponent(workspaceId)}/code-agents/${encodeURIComponent(path)}`;
}

/** The code-agent URL patterns `codeAgentRedirect` rewrites, in match order (first match wins). */
const CODE_AGENT_PATTERNS = ['/code-agents/:path', '/w/:ws/code-agents/:path'] as const;

/**
 * Where a code-agent URL must go instead, or `null` to stay (the hash's
 * query string is preserved on every redirect):
 *
 * - `/code-agents/:path` (the pre-W08b link) →
 *   `/w/<launchId>/code-agents/:path`; `null` while `launchId` is still
 *   unknown so the caller waits for `GET /workspaces`.
 * - `/w/<ws>/code-agents/:path` with a `ws` that fails `WORKSPACE_ID_RE`
 *   → `/agents`.
 */
export function codeAgentRedirect(hash: string, launchId: string | undefined): string | null {
  const route = matchRoute(hash, [...CODE_AGENT_PATTERNS]);
  if (route === null) return null;
  const { path, ws } = route.params;
  const qs = route.query.toString();
  const withQuery = (target: string) => (qs === '' ? target : `${target}?${qs}`);

  // A workspace-scoped row only needs its id validated; the bare row
  // waits for the launch workspace, then rewrites into it.
  if (ws !== undefined) return WORKSPACE_ID_RE.test(ws) ? null : withQuery('/agents');
  if (launchId === undefined || path === undefined) return null;
  return withQuery(codeAgentPath(launchId, path));
}
