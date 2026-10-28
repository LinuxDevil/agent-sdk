/**
 * The route kit the daemon's feature files share: the {@link Route}/
 * {@link RouteContext} contract, the bounded-body error, and the small
 * response/param helpers. It lives beside `index.ts` rather than in it so
 * feature files import it without closing an import cycle through the
 * registry (which imports every feature file).
 */

import type * as http from 'node:http';
import { z } from 'zod';
import { SDKError } from '../../execution/errors';
import type { SqlDatabase } from '../../storage/sqlite/driver';
import { sendJson } from '../../server/sendJson';
import type { EvaluatorWorker } from '../evaluatorWorker';

export { sendJson };

/** What a handler gets: the request, the matched `:params`, the query, the db, and a bounded body reader. */
export interface RouteContext {
  db: SqlDatabase;
  /** The db file path the daemon was started with (`:memory:` for tests). */
  dbPath: string;
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
  /** The daemon's online-evaluator worker (ingest notifies it; the evaluator `/test` route dry-runs through it). */
  evaluators: EvaluatorWorker;
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

/**
 * `parseJsonBody` plus a zod check: the JSON parse and the schema failure
 * both throw `LOUSHO_REQUEST_INVALID`, the schema failure naming `what`
 * (`'hub publish'`, `'prompt publish'`) and the first issue.
 */
export function requireJsonBody<S extends z.ZodType>(schema: S, text: string, what: string): z.infer<S> {
  const parsed = schema.safeParse(parseJsonBody(text));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SDKError(
      `Invalid ${what} body: ${issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'bad shape'}.`,
      'LOUSHO_REQUEST_INVALID',
      { appendHelp: false }
    );
  }
  return parsed.data;
}
