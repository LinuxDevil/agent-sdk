/**
 * The daemon's route registry. One file per feature area (ingest, traces,
 * insights, agents, scores, status) exports a `routes` array; this index
 * concatenates them - so a later child spec (prompts, hub, alerts) adds a
 * file here and never touches the daemon's dispatch internals.
 *
 * A route is `{ method, path, handler }` where `path` is a literal template
 * with `:param` segments (`/api/v1/traces/:id`). No framework: the API is a
 * dozen endpoints, so a segment matcher is enough and keeps `node:http` the
 * only server dependency.
 */

import type * as http from 'node:http';
import type { SqlDatabase } from '../../storage/sqlite/driver';
import { SDKError } from '../../execution/errors';
import { agentsRoutes } from './agents';
import { ingestRoutes } from './ingest';
import { insightsRoutes } from './insights';
import { scoresRoutes } from './scores';
import { statusRoutes } from './status';
import { tracesRoutes } from './traces';

/** What a handler gets: the request, the matched `:params`, the query, the db, and a bounded body reader. */
export interface RouteContext {
  db: SqlDatabase;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  /**
   * The request body as text, at most `limitBytes`; a body over the limit
   * throws {@link BodyTooLargeError} (the daemon answers `413`). Throws
   * `LOUSHO_REQUEST_INVALID` on a second call.
   */
  readBody(limitBytes: number): Promise<string>;
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Literal path template; `:name` captures one path segment. */
  path: string;
  handle(ctx: RouteContext): void | Promise<void>;
}

/** Thrown by `ctx.readBody` when the body exceeds the byte cap; the daemon maps it to 413. */
export class BodyTooLargeError extends Error {
  override readonly name = 'BodyTooLargeError';
}

/** Every registered route, feature files in order. Later children append their own import + spread. */
export const routes: readonly Route[] = [
  ...statusRoutes,
  ...ingestRoutes,
  ...tracesRoutes,
  ...insightsRoutes,
  ...agentsRoutes,
  ...scoresRoutes,
];

interface CompiledRoute {
  route: Route;
  segments: string[];
}

const compiled: CompiledRoute[] = routes.map((route) => ({ route, segments: route.path.split('/').filter(Boolean) }));

/** Find the route for `method`/`pathname`; `params` gets the `:name` captures. `undefined` when none matches. */
export function matchRoute(
  method: string,
  pathname: string
): { route: Route; params: Record<string, string> } | undefined {
  const parts = pathname.split('/').filter(Boolean);
  for (const { route, segments } of compiled) {
    if (route.method !== method || segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let match = true;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(parts[i]);
      else if (segment !== parts[i]) {
        match = false;
        break;
      }
    }
    if (match) return { route, params };
  }
  return undefined;
}

export function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

/** A `400`-shaped answer in the API's `{ error, code }` body style. */
export function badRequest(res: http.ServerResponse, message: string): void {
  sendJson(res, 400, { error: message, code: 'LOUSHO_REQUEST_INVALID' });
}

/** A query param as a bounded positive integer (`fallback` when absent). */
export function intParam(
  query: URLSearchParams,
  name: string,
  fallback: number,
  bounds: { min: number; max: number }
): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

/** A query param as epoch milliseconds, or `undefined`. */
export function timeParam(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Rejects a malformed JSON body with the envelope-parse code. */
export function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SDKError('The request body is not valid JSON.', 'LOUSHO_REQUEST_INVALID', { appendHelp: false });
  }
}
