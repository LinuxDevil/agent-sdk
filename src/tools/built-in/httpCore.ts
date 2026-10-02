/**
 * The Node-free core of the `http_request` tool (M3a), shared by the Node
 * tool (./http.ts) and the Cloudflare Worker tool (./workerHttp.ts): the
 * input schema, the request with its timeout and caller cancellation, the
 * manual redirect loop and the response reading.
 *
 * Nothing here decides which destinations are allowed. Each caller injects
 * `checkHop`, run on every redirect target before it is requested (the caller
 * checks the first URL itself), and a transport that performs the request:
 * on Node an undici fetch whose connections resolve through the pinned lookup,
 * on a Worker the platform `fetch()`.
 *
 * No `node:*` import may be added here: the Worker bundle includes this file.
 */

import { z } from 'zod';

/** The methods `http_request` accepts. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/** The request a transport receives. */
export interface HttpTransportInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  redirect: 'manual';
}

/** Performs one request (no redirects followed) and resolves with its response. */
export type HttpTransport = (url: string, init: HttpTransportInit) => Promise<Response>;

/** The tool's description, the same on Node and on Workers. */
export const HTTP_TOOL_DESCRIPTION =
  'Makes HTTP requests to specified URLs with configurable method, headers, and body. Supports GET, POST, PUT, DELETE, and PATCH methods.';

/** The tool's input, the same on Node and on Workers. */
export const httpRequestInput = z.object({
  url: z.string().describe('The URL to make the request to (must be a valid HTTP/HTTPS URL)'),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).describe('The HTTP method to use'),
  headers: z.record(z.string(), z.string()).optional().describe('Optional headers to include in the request as key-value pairs'),
  body: z.string().optional().describe('The body of the request. For POST/PUT/PATCH, this should be a JSON string. Not used for GET/DELETE.'),
});

export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_REDIRECTS = 5;

const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;

function isIPv6(address: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(address)) return false;
  // A trailing dotted IPv4 (`::ffff:1.2.3.4`) stands for two groups.
  const v4 = /:([^:]+\.[^:]+)$/.exec(address);
  if (v4 && !IPV4.test(v4[1])) return false;
  const groups = v4 ? `${address.slice(0, -v4[1].length)}0:0` : address;
  const halves = groups.split('::');
  if (halves.length > 2) return false;
  const split = (half: string): string[] => (half === '' ? [] : half.split(':'));
  const parts = [...split(halves[0]), ...(halves.length === 2 ? split(halves[1]) : [])];
  if (!parts.every((part) => IPV6_GROUP.test(part))) return false;
  return halves.length === 2 ? parts.length <= 7 : parts.length === 8;
}

/**
 * `node:net`'s `isIP()` without Node: 4 for a dotted-decimal IPv4 address, 6
 * for an IPv6 address (brackets not included, no zone id), 0 otherwise.
 */
export function ipFamily(address: string): 0 | 4 | 6 {
  if (IPV4.test(address)) return 4;
  return isIPv6(address) ? 6 : 0;
}

/** The redirect target of a 3xx response, or null/'' when it is not a redirect. */
function redirectLocation(response: Response): string | null {
  return response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
}

/**
 * Issue the request and follow up to `maxRedirects` redirects by hand
 * (`redirect: 'manual'`). `checkHop` sees every redirect target before it is
 * requested and throws to refuse it; `tooManyRedirects` builds the error for
 * a chain longer than `maxRedirects`.
 */
async function fetchFollowingRedirects(
  transport: HttpTransport,
  url: string,
  init: HttpTransportInit,
  maxRedirects: number,
  checkHop: (url: URL) => void | Promise<void>,
  tooManyRedirects: (maxRedirects: number) => Error
): Promise<Response> {
  let currentUrl = url;
  let redirectCount = 0;
  let response = await transport(currentUrl, init);
  let location = redirectLocation(response);

  while (location) {
    redirectCount++;
    if (redirectCount > maxRedirects) {
      throw tooManyRedirects(maxRedirects);
    }
    currentUrl = new URL(location, currentUrl).toString();
    await checkHop(new URL(currentUrl));
    response = await transport(currentUrl, init);
    location = redirectLocation(response);
  }
  return response;
}

/** Throw `httpError(response)` on a non-2xx response; otherwise return the body (JSON re-serialized). */
async function readResponseBody(response: Response, httpError: (response: Response) => Error): Promise<string> {
  if (!response.ok) {
    throw httpError(response);
  }

  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    const data = await response.json();
    return JSON.stringify(data);
  }
  return await response.text();
}

/**
 * Aborts `controller` when the caller's `signal` aborts (LOU-V1), so the
 * run's cancellation reaches the in-flight fetch. Returns the unlink
 * function to call once the request settles.
 */
function linkCallerSignal(controller: AbortController, signal: AbortSignal | undefined): () => void {
  if (!signal) {
    return () => undefined;
  }
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) {
    onAbort();
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/** The error reported when the caller cancelled the request. */
export function abortedRequestError(): Error {
  const error = new Error('HTTP request was aborted');
  error.name = 'AbortError';
  return error;
}

/** One request, after its first URL passed the caller's own check. */
export interface HttpCoreRequest {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
  /** Cancels the request (LOU-V1). */
  signal?: AbortSignal;
  timeoutMs: number;
  maxRedirects: number;
}

/** What differs between the Node and the Worker tool. */
export interface HttpCoreHooks {
  transport: HttpTransport;
  /** Run on every redirect target before it is requested; throws to refuse it. */
  checkHop: (url: URL) => void | Promise<void>;
  /** Maps whatever the request threw to the error reported. */
  mapError: (error: unknown) => Error;
  /** The error for a redirect chain longer than `maxRedirects`. */
  tooManyRedirects: (maxRedirects: number) => Error;
  /** The error for a non-2xx response. */
  httpError: (response: Response) => Error;
  /** Run once the request settled, whatever the outcome. */
  cleanup?: () => void | Promise<void>;
}

/**
 * Performs `request` through `hooks.transport` with a timeout, the caller's
 * cancellation and manual redirects checked by `hooks.checkHop`, and returns
 * the response body. Every failure goes through `hooks.mapError`.
 */
export async function runHttpRequest(request: HttpCoreRequest, hooks: HttpCoreHooks): Promise<string> {
  const { url, method, headers, body, signal, timeoutMs, maxRedirects } = request;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const unlinkSignal = linkCallerSignal(controller, signal);

  try {
    const init: HttpTransportInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body && method !== 'GET' ? body : undefined,
      signal: controller.signal,
      redirect: 'manual',
    };

    const response = await fetchFollowingRedirects(hooks.transport, url, init, maxRedirects, hooks.checkHop, hooks.tooManyRedirects);

    clearTimeout(timeoutId);
    return await readResponseBody(response, hooks.httpError);
  } catch (error) {
    clearTimeout(timeoutId);
    throw hooks.mapError(error);
  } finally {
    clearTimeout(timeoutId);
    unlinkSignal();
    await hooks.cleanup?.();
  }
}
