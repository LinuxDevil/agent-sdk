/**
 * Bearer-token auth for the deployed node server (LOU-D14). Node-only: the
 * constant-time compare uses `node:crypto`, so it is kept out of chatRoutes.ts.
 */
import type * as http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Whether `header` is `Bearer <token>`; compared in constant time (both sides hashed to one length first). */
function hasBearerToken(header: string | undefined, token: string): boolean {
  const presented = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1];
  return presented !== undefined && timingSafeEqual(digest(presented), digest(token));
}

/**
 * Lets `req` through when it carries `Authorization: Bearer <token>`; otherwise
 * answers 401 JSON and returns false.
 */
export function authorize(req: http.IncomingMessage, res: http.ServerResponse, token: string): boolean {
  if (hasBearerToken(req.headers.authorization, token)) return true;
  res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
  res.end(JSON.stringify({ error: 'Unauthorized: send Authorization: Bearer <token>' }));
  return false;
}
