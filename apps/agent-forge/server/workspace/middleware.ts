/**
 * Per-request workspace resolution.
 *
 * Mounted right after `express.json`, before the first route, so it runs
 * on every request: it reads the workspace id the client asked for
 * (`x-lousho-workspace` header, else `?ws=`), resolves it through the
 * app's `WorkspaceResolver`, and remembers the resulting
 * `WorkspaceContext` for `workspaceOf(req)`. Route handlers then read
 * their per-workspace stores from `workspaceOf(req)` and never close over
 * a singleton.
 *
 * A malformed id is a 400 (`LOUSHO_WORKSPACE_ID_INVALID`) and a valid but
 * unknown one a 404 (`LOUSHO_WORKSPACE_NOT_FOUND`) - the request never
 * reaches a route that would silently serve the wrong workspace.
 */
import type { Request, RequestHandler } from 'express';
import {
  ALL_WORKSPACES,
  WORKSPACE_HEADER,
  WORKSPACE_ID_RE,
  WORKSPACE_QUERY,
} from '../../shared/workspace';
import { sendError } from '../http/routeUtils';
import type { WorkspaceContext, WorkspaceResolver } from './context';

/** The resolved context for each in-flight request, keyed by the request object itself. */
const contexts = new WeakMap<Request, WorkspaceContext>();

/**
 * The workspace id the request asks for: the `WORKSPACE_HEADER` header
 * (trimmed, non-empty) first - the header wins over the query - else
 * `?WORKSPACE_QUERY=` when it is a single string, else `undefined`
 * (a repeated or non-scalar `?ws=` is not a string and returns undefined
 * here; the middleware treats the repeated-array form as invalid).
 */
export function requestedWorkspaceId(req: Request): string | undefined {
  const header = req.get(WORKSPACE_HEADER)?.trim();
  if (header) return header;
  const query = req.query[WORKSPACE_QUERY];
  return typeof query === 'string' ? query : undefined;
}

/**
 * Resolves each request's workspace once and remembers it for
 * `workspaceOf(req)`: none or `all` → the resolver's default context (one
 * workspace is all of them today); a malformed id (or `?ws=` given twice)
 * → 400; a valid id the resolver doesn't know → 404; anything else →
 * that context.
 */
export function workspaceMiddleware(resolver: WorkspaceResolver): RequestHandler {
  return (req, res, next) => {
    const id = requestedWorkspaceId(req);
    // `?ws=` repeated parses to an array - ambiguous which workspace is
    // meant, so reject (unless the header picked one: the header wins).
    const ambiguousQuery = !req.get(WORKSPACE_HEADER)?.trim() && Array.isArray(req.query[WORKSPACE_QUERY]);
    if (ambiguousQuery || (id !== undefined && id !== ALL_WORKSPACES && !WORKSPACE_ID_RE.test(id))) {
      sendError(res, 400, 'Invalid workspace id', 'LOUSHO_WORKSPACE_ID_INVALID');
      return;
    }
    resolver
      .resolve(id)
      .then((ctx) => {
        if (!ctx) {
          sendError(res, 404, `No workspace '${id}'`, 'LOUSHO_WORKSPACE_NOT_FOUND');
          return;
        }
        contexts.set(req, ctx);
        next();
      })
      .catch(next);
  };
}

/**
 * The `WorkspaceContext` `workspaceMiddleware` resolved for this request.
 * Throws when called on a request the middleware never saw (a route
 * mounted without it - a wiring bug, not a client error).
 */
export function workspaceOf(req: Request): WorkspaceContext {
  const ctx = contexts.get(req);
  if (!ctx) {
    throw new Error('workspaceOf() ran on a request the workspace middleware did not see');
  }
  return ctx;
}
