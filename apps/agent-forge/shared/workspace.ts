/**
 * Workspace identity primitives, shared by the Studio server and client.
 *
 * One Studio serves one or more project folders ("workspaces"); today it
 * serves exactly one - the folder it was launched in - but every request
 * already names its workspace so the client and server grow the multi-
 * workspace routes (registry, aggregate lists) without a second breaking
 * change. React-free: both `src/` (client) and `server/` import this.
 */

/** Header the client sends on every API request to pick a workspace. */
export const WORKSPACE_HEADER = 'x-lousho-workspace';

/** Query key with the same meaning (WebSocket URLs, links); the header wins when both are present. */
export const WORKSPACE_QUERY = 'ws';

/** Reserved value meaning "every workspace" (aggregate routes). Never a workspace id. */
export const ALL_WORKSPACES = 'all';

/** slug (1..40 chars) + '-' + 6 lowercase hex - the shape `workspaceIdFor()` emits. */
export const WORKSPACE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?-[0-9a-f]{6}$/;

/** One registered workspace: a project folder Studio knows about. */
export interface WorkspaceRef {
  /** `slug(basename(root)) + '-' + sha256(realpath(root))[0:6]` - stable across renames of the launch dir's case. */
  id: string;
  /** Display name (the folder's basename). */
  name: string;
  /** Canonical absolute path of the folder (realpath when it exists). */
  root: string;
  /** ISO timestamp of when the workspace was added to the registry. */
  addedAt: string;
  /** ISO timestamp of when Studio last served it. */
  lastOpenedAt: string;
}
