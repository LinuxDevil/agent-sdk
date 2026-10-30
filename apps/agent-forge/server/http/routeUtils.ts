/**
 * Small Express helpers shared by the Studio server's route modules.
 * `asyncRoute` and `paramId` moved here from app.ts unchanged so route
 * modules registered outside app.ts can use them too; `sendError` is the
 * one place the `{ error, code?, details? }` response shape is emitted.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async route handler so a rejected promise reaches Express's
 * error middleware via `next()` instead of surfacing as an unhandled
 * rejection. (Express 5 forwards async errors itself, but every handler in
 * this server goes through this wrapper for consistency.)
 */
export function asyncRoute(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

/**
 * `req.params[name]` narrowed to a string: Express 5 types it
 * `string | string[]` (a route param can repeat, e.g. `/:id+`). None of
 * this server's routes use repeating params, so the value is a single
 * string in practice - the `Array.isArray` check just satisfies the type.
 */
export function paramId(req: Request, name = 'id'): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Replies `status` with the Studio error body `{ error, code?, details? }`;
 * the `code` and `details` keys are omitted entirely when undefined so
 * simple errors keep the minimal `{ error }` shape existing clients see.
 */
export function sendError(res: Response, status: number, error: string, code?: string, details?: unknown): void {
  const body: { error: string; code?: string; details?: unknown } = { error };
  if (code !== undefined) body.code = code;
  if (details !== undefined) body.details = details;
  res.status(status).json(body);
}
