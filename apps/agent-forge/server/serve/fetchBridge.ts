/**
 * fetchBridge - the Express ↔ Fetch `Request`/`Response` adapter (X02a).
 *
 * The SDK's chat routes are Fetch-API handlers (`createRouteHandler`),
 * but Studio is Express. These two functions bridge the gap for the
 * `/serve/<id>/*` surface without `express.json()` ever seeing the body:
 *
 * - `toFetchRequest` rebuilds an absolute `Request` from the raw Node
 *   stream (`Readable.toWeb(req)` + `duplex: 'half'`), so the SDK sees
 *   exactly the bytes the caller sent - including SSE-unfriendly cases
 *   like chunked uploads.
 * - `sendFetchResponse` copies status + headers back and pipes the body,
 *   cancelling the reader when the client hangs up so an abandoned SSE
 *   stream doesn't keep the agent run alive.
 */
import { Readable } from 'node:stream';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { pipeline } from 'node:stream/promises';

/** Hop-by-hop headers Express must recompute for the proxied response. */
const SKIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
]);

/**
 * The Fetch `Request` for `req`, addressed at
 * `http://<Host><originalUrl>` so the SDK route handler's `basePath`
 * stripping sees the full `/serve/<id>/...` path.
 */
export function toFetchRequest(req: ExpressRequest): Request {
  const host = req.headers.host ?? 'localhost';
  const url = `http://${host}${req.originalUrl ?? req.url}`;
  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  // IncomingHttpHeaders allows `undefined` values and `string[]`; a Fetch
  // Headers record wants plain strings, so undefined entries drop out.
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[key] = value;
    else if (Array.isArray(value)) headers[key] = value.join(', ');
  }
  return new Request(url, {
    method,
    headers,
    ...(hasBody
      ? // undici requires `duplex: 'half'` for a streaming body; the SDK's
        // RequestInit type predates it, hence the cast.
        ({ body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } as RequestInit)
      : {}),
  });
}

/** Streams `response` back through `res`, honouring client disconnects. */
export async function sendFetchResponse(res: ExpressResponse, response: Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, key) => {
    if (!SKIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
  });
  if (response.body === null) {
    res.end();
    return;
  }
  const nodeBody = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  // `pipeline` rejects on either side's error; a client 'close' before the
  // body finishes surfaces as an error there, and cancelling the web
  // reader releases the SDK's SSE producer. A disconnect is not an
  // application error - swallow it once `res` is gone.
  res.on('close', () => {
    void response.body?.cancel().catch(() => undefined);
  });
  try {
    await pipeline(nodeBody, res);
  } catch (error) {
    if (!res.destroyed && !res.writableEnded) throw error;
  }
}
