import { z } from 'zod';
import { isIP } from 'net';
import { promises as dnsPromises } from 'dns';
import { lazyValue, loadOptionalPeer } from '../../providers/optionalPeer';
import { ToolDescriptor, ToolExecutionContext } from '../../types';
import { SandboxAdapter } from '../../security/sandboxCore';
import { sandboxHttpFetch } from './sandboxFetch';
import { defineTool } from '../defineTool';

/**
 * HTTP Tool Configuration Options
 */
export interface HttpToolOptions {
  /**
   * Maximum timeout for HTTP requests in milliseconds
   * @default 30000 (30 seconds)
   */
  timeout?: number;

  /**
   * Maximum number of redirects to follow
   * @default 5
   */
  maxRedirects?: number;

  /**
   * Whether to validate SSL certificates
   * @default true
   */
  validateSSL?: boolean;
}

/**
 * Default SSRF denylist: loopback, RFC1918 private ranges, link-local
 * (including the cloud metadata endpoint at 169.254.169.254), and their
 * IPv6 equivalents. Active by default with no opt-in flag.
 *
 * Note: fc00::/7 (unique local addresses) spans fc00:: through
 * fdff:ffff:..., so the second hex nibble after "f" must match both "c"
 * and "d" (case-insensitively, since IPv6 literals may be upper/lower/mixed
 * case before normalization).
 */
const BLOCKED_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe80:/i,
];

/**
 * Strip surrounding IPv6 brackets (`[::1]` -> `::1`) and lowercase, since
 * `new URL(...).hostname` keeps the brackets for IPv6 literals and may
 * preserve mixed case that our regexes assume is already lowercase.
 */
function normalizeHostLiteral(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/**
 * If `address` is an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` or its
 * compressed hex form `::ffff:HHHH:HHHH`), extract and return the embedded
 * IPv4 address in dotted-decimal form. Returns null otherwise.
 */
function extractMappedIPv4(address: string): string | null {
  const dotted = address.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (dotted) {
    return dotted[1];
  }

  const hex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [
      (hi >> 8) & 0xff,
      hi & 0xff,
      (lo >> 8) & 0xff,
      lo & 0xff,
    ].join('.');
  }

  return null;
}

/**
 * Check a single resolved/literal IP address (v4 or v6, already stripped
 * of brackets) against the SSRF denylist, unwrapping IPv4-mapped IPv6
 * addresses first so `::ffff:127.0.0.1` (and its compressed hex form) is
 * caught the same way `127.0.0.1` is.
 */
function isBlockedAddress(address: string): boolean {
  const normalized = normalizeHostLiteral(address);

  const mappedIPv4 = extractMappedIPv4(normalized);
  if (mappedIPv4 && BLOCKED_RANGES.some((re) => re.test(mappedIPv4))) {
    return true;
  }

  return BLOCKED_RANGES.some((re) => re.test(normalized));
}

/**
 * Determine whether a request to `hostname` should be blocked by the SSRF
 * denylist.
 *
 * - If `hostname` is already an IP literal (`net.isIP` != 0), it is checked
 *   directly.
 * - Otherwise `hostname` is a domain name. It is resolved via DNS *before*
 *   any connection is attempted, and EVERY resolved address is checked
 *   against the denylist. This closes the DNS-rebinding gap where an
 *   attacker-controlled domain resolves to a blocked internal/loopback IP.
 * - If DNS resolution itself fails, that is not treated as a block; the
 *   normal fetch error is left to surface from the caller's own connection
 *   attempt instead of being reported as an SSRF rejection.
 *
 * Decimal/octal/hex IPv4 encodings (e.g. `2130706433`, `017700000001`,
 * `0x7f000001`) are not handled with bespoke parsing here: `new URL(...)`
 * already normalizes all three forms to dotted-decimal (`127.0.0.1`) before
 * `hostname` is ever read, which is verified by a regression test in
 * http.test.ts.
 */
async function isBlockedHost(hostname: string): Promise<boolean> {
  const bare = normalizeHostLiteral(hostname);

  if (isIP(bare)) {
    return isBlockedAddress(bare);
  }

  try {
    const resolved = await dnsPromises.lookup(bare, { all: true });
    return resolved.some((entry) => isBlockedAddress(entry.address));
  } catch {
    // DNS resolution failed (e.g. NXDOMAIN). Don't swallow this as a
    // block - let the subsequent fetch() attempt fail with its own,
    // more informative network error.
    return false;
  }
}

/**
 * A minimal fetch-response-shaped transport function that actually performs
 * the outbound request. `makeHttpRequest()` is transport-agnostic: the
 * default transport calls `fetch` directly (undici's, only for
 * `validateSSL: false`); `makeHttpRequestViaSandbox()` below supplies a
 * transport that routes the same request through a SandboxAdapter instead
 * (LOU-K2).
 */
type HttpTransport = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    redirect: 'manual';
  }
) => Promise<Response>;

/**
 * Default transport. With TLS verification on (the default) it is the
 * runtime's global `fetch`: nothing about the request needs `undici`, so the
 * package is not even loaded (LOU-D40). Only `validateSSL: false` needs a
 * per-request TLS setting, which is scoped to a dedicated undici Agent
 * (dispatcher) rather than the process-wide NODE_TLS_REJECT_UNAUTHORIZED env
 * var, since the env var is global mutable state and toggling it around an
 * await point would race under concurrent requests.
 */
function createDirectTransport(validateSSL: boolean): { transport: HttpTransport; close: () => Promise<void> } {
  if (validateSSL) return { transport: (url, init) => fetch(url, init), close: async () => {} };
  // undici is loaded on first request, not at import time (LOU-D19).
  let started = false;
  const load = lazyValue(async () => {
    const { Agent, fetch } = await loadOptionalPeer('undici', () => import('undici'));
    started = true;
    return { fetch, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) };
  });
  return {
    transport: async (url, init) => {
      const { fetch, dispatcher } = await load();
      return fetch(url, { ...init, dispatcher }) as unknown as Promise<Response>;
    },
    close: async () => {
      if (started) await (await load()).dispatcher.close();
    },
  };
}

/**
 * Transport that routes the request through a SandboxAdapter (LOU-K2) via
 * sandboxHttpFetch() rather than calling undici's fetch directly - the
 * actual outbound network call happens inside `sandbox.run()` (a Node
 * subprocess under NoopSandbox; a real isolated command under e.g.
 * SubprocessSandbox) instead of in this process.
 */
function createSandboxTransport(sandbox: SandboxAdapter, validateSSL: boolean, timeoutMs: number): HttpTransport {
  return (url, init) =>
    sandboxHttpFetch(
      sandbox,
      { url, method: init.method, headers: init.headers, body: init.body, insecureTLS: !validateSSL },
      { timeoutMs, signal: init.signal }
    );
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/** One outbound request, as makeHttpRequest()/makeHttpRequestViaSandbox() take it. */
interface HttpRequestArgs {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
  options?: HttpToolOptions;
  /** Cancels the request (LOU-V1); it then rejects with an `AbortError`. */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_REDIRECTS = 5;

/** Reject `hostname` if it is on the SSRF denylist. */
async function assertHostAllowed(hostname: string): Promise<void> {
  if (await isBlockedHost(hostname)) {
    throw new Error(`Request to blocked host ${hostname} rejected by SSRF denylist`);
  }
}

/** The redirect target of a 3xx response, or null/'' when it is not a redirect. */
function redirectLocation(response: Response): string | null {
  return response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
}

/**
 * Issue the request and follow up to `maxRedirects` redirects by hand
 * (`redirect: 'manual'`), SSRF-checking every redirect target first.
 */
async function fetchFollowingRedirects(
  transport: HttpTransport,
  url: string,
  init: Parameters<HttpTransport>[1],
  maxRedirects: number
): Promise<Response> {
  let currentUrl = url;
  let redirectCount = 0;
  let response = await transport(currentUrl, init);
  let location = redirectLocation(response);

  while (location) {
    redirectCount++;
    if (redirectCount > maxRedirects) {
      throw new Error(`Exceeded maxRedirects (${maxRedirects})`);
    }
    currentUrl = new URL(location, currentUrl).toString();
    await assertHostAllowed(new URL(currentUrl).hostname);
    response = await transport(currentUrl, init);
    location = redirectLocation(response);
  }
  return response;
}

/** Throw on a non-2xx response; otherwise return the body (JSON re-serialized). */
async function readResponseBody(response: Response): Promise<string> {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
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
function abortedRequestError(): Error {
  const error = new Error('HTTP request was aborted');
  error.name = 'AbortError';
  return error;
}

/** Map whatever a request threw to the error performHttpRequest() reports. */
function toHttpRequestError(error: unknown, timeoutMs: number, callerSignal?: AbortSignal): Error {
  if (callerSignal?.aborted) {
    return abortedRequestError();
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error(`Request timed out after ${timeoutMs}ms`);
  }
  if (error instanceof Error) {
    return new Error(`HTTP request failed: ${error.message}`);
  }
  return new Error('HTTP request failed with unknown error');
}

/**
 * Core request/redirect/SSRF logic, parameterized by `transport` so it can
 * be shared between the direct (unsandboxed) and sandboxed code paths
 * without duplicating the SSRF-checking/redirect-following logic.
 */
async function performHttpRequest(
  {
    url,
    method,
    headers,
    body,
    options = {},
    signal,
  }: HttpRequestArgs,
  transport: HttpTransport,
  getCleanup: () => (() => void | Promise<void>) | void
): Promise<string> {
  await assertHostAllowed(new URL(url).hostname);

  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const unlinkSignal = linkCallerSignal(controller, signal);
  const cleanup = getCleanup();

  try {
    const fetchOptions = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body && method !== 'GET' ? body : undefined,
      signal: controller.signal,
      redirect: 'manual' as const,
    };

    const response = await fetchFollowingRedirects(
      transport,
      url,
      fetchOptions,
      options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
    );

    clearTimeout(timeoutId);
    return await readResponseBody(response);
  } catch (error) {
    clearTimeout(timeoutId);
    throw toHttpRequestError(error, timeoutMs, signal);
  } finally {
    clearTimeout(timeoutId);
    unlinkSignal();
    await cleanup?.();
  }
}

/**
 * Makes HTTP requests to external APIs. Unchanged, original behavior: goes
 * straight to undici's fetch (with the per-request TLS dispatcher), never
 * routed through any SandboxAdapter. This remains the implementation behind
 * the HTTP tool's plain `execute()` - see makeHttpRequestViaSandbox() below
 * for the sandboxed path used by `sandboxExecute()`.
 */
export async function makeHttpRequest(args: HttpRequestArgs): Promise<string> {
  const { transport, close } = createDirectTransport(args.options?.validateSSL !== false);
  return performHttpRequest(args, transport, () => close);
}



/**
 * Same request/redirect/SSRF logic as makeHttpRequest(), but the actual
 * outbound fetch is performed through `sandbox` (LOU-K2) via
 * sandboxHttpFetch() instead of calling undici's fetch directly in this
 * process.
 */
export async function makeHttpRequestViaSandbox(
  args: HttpRequestArgs,
  sandbox: SandboxAdapter
): Promise<string> {
  const timeoutMs = args.options?.timeout ?? 30000;
  const transport = createSandboxTransport(sandbox, args.options?.validateSSL !== false, timeoutMs + 5000);
  return performHttpRequest(args, transport, () => undefined);
}

/**
 * Create HTTP Tool
 * Factory function to create an HTTP tool with custom options
 */
export function createHttpTool(options: HttpToolOptions = {}): ToolDescriptor {
  return defineTool({
    name: 'http_request',
    displayName: 'Make HTTP request',
    description: 'Makes HTTP requests to specified URLs with configurable method, headers, and body. Supports GET, POST, PUT, DELETE, and PATCH methods.',
    input: z.object({
      url: z.string().describe('The URL to make the request to (must be a valid HTTP/HTTPS URL)'),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).describe('The HTTP method to use'),
      headers: z.record(z.string(), z.string()).optional().describe('Optional headers to include in the request as key-value pairs'),
      body: z.string().optional().describe('The body of the request. For POST/PUT/PATCH, this should be a JSON string. Not used for GET/DELETE.'),
    }),
    execute: async ({ url, method, headers, body }, ctx) => {
      // `?.`: direct callers have historically passed no context object.
      const signal = ctx?.abortSignal;
      return makeHttpRequest({ url, method, headers, body, options, signal });
    },
    // LOU-K2: httpTool makes arbitrary, model-chosen outbound HTTP requests
    // - the highest-risk built-in tool for a sandbox boundary to be
    // meaningful on. A caller going through executeToolWithSandboxGuard()
    // (AgentExecutor, resume.ts) gets the actual fetch routed through the
    // configured SandboxAdapter via sandboxExecute(); execute() above is
    // left unchanged (still real, directly callable) for callers that
    // invoke descriptor.execute() directly.
    requiresSandbox: true,
    sandboxExecute: async (args, sandbox, callOptions?: ToolExecutionContext) =>
      makeHttpRequestViaSandbox({ ...args, options, signal: callOptions?.abortSignal }, sandbox),
  });
}

/**
 * Default HTTP Tool instance
 */
export const httpTool: ToolDescriptor = createHttpTool();
