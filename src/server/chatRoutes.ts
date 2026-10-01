/**
 * The `/chat` HTTP API of `loushy dev` and of the deployed node server
 * (LOU-D32, LOU-D14) on `node:http`. The routes themselves are Fetch-native
 * (fetchRoutes.ts, shared with the Cloudflare Worker, LOU-D51); this file
 * adapts an `IncomingMessage` / `ServerResponse` pair to a `Request` /
 * `Response`, so only Node hosts import it.
 */
import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { handleChatFetch, type ChatRoutesContext } from './fetchRoutes';

export type { ChatRoutesContext } from './fetchRoutes';

export function sendText(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(text);
}

export function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

/** `req` as a Fetch `Request` (its body streamed, not buffered) that aborts when `res` closes. */
function toRequest(req: http.IncomingMessage, res: http.ServerResponse): Request {
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(new URL(req.url ?? '/', 'http://localhost'), {
    method: req.method,
    headers,
    signal: abort.signal,
    ...(hasBody && { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' }),
  });
}

/** Writes `response` to `res`, chunk by chunk (SSE frames go out as they are produced); a closed `res` cancels the body. */
async function writeResponse(res: http.ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => (headers[name] = value));
  res.writeHead(response.status, headers);
  const reader = response.body?.getReader();
  res.on('close', () => void reader?.cancel());
  for (let chunk = await reader?.read(); chunk && !chunk.done; chunk = await reader?.read()) res.write(chunk.value);
  res.end();
}

/**
 * Runs the Fetch `handler` on `req` and writes its response to `res`, resolving
 * `true`; resolves `false` (nothing written) when the handler has no response.
 */
export async function relayFetch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handler: (request: Request) => Promise<Response | undefined>
): Promise<boolean> {
  const response = await handler(toRequest(req, res));
  if (response) await writeResponse(res, response);
  return response !== undefined;
}

/**
 * Handles `req` when it is one of the `/chat` routes and resolves `true`; resolves
 * `false` (nothing written) for any other request, so the host can serve its own
 * routes. A failure before streaming starts answers with a JSON error.
 */
export function handleChatRequest(req: http.IncomingMessage, res: http.ServerResponse, ctx: ChatRoutesContext): Promise<boolean> {
  return relayFetch(req, res, (request) => handleChatFetch(request, ctx));
}
