import { z } from 'zod';
import { isIP } from 'net';
import { lazyValue, loadOptionalPeer } from '../../providers/optionalPeer';
import { ToolDescriptor, ToolExecutionContext } from '../../types';
import { SandboxAdapter } from '../../security/sandboxCore';
import { matchesHost } from '../../security/hostPattern';
import {
  findSsrfBlockedError,
  isPrivateAddress,
  pinnedLookup,
  resolvePublicAddresses,
  SsrfBlockedError,
} from '../../security/privateAddress';
import { sandboxHttpFetch } from './sandboxFetch';
import { defineTool } from '../defineTool';
import { toolFailure } from './toolFailure';

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

  /**
   * Host patterns (`intranet.example`, `*.corp.example`, or an IP literal)
   * allowed to be or resolve to loopback, link-local or private addresses,
   * which are refused otherwise.
   * @default []
   */
  allowPrivate?: readonly string[];
}

/**
 * SSRF policy (N13a). IP-literal hosts are checked here, before any request:
 * a socket never resolves a literal, so nothing else would see it. Names are
 * checked by the transport at connection time with the shared pinned lookup
 * (src/security/privateAddress.ts): the one resolution of the name is the one
 * that is checked and the one the socket connects to, so a DNS-rebinding name
 * that answers a public address first and a private one later has no second
 * lookup to answer.
 *
 * Decimal/octal/hex IPv4 encodings (e.g. `2130706433`, `017700000001`,
 * `0x7f000001`) need no bespoke parsing: `new URL(...)` already normalizes
 * all three forms to dotted-decimal (`127.0.0.1`) before `hostname` is read,
 * which is verified by a regression test in http.test.ts.
 */
function assertLiteralAllowed(hostname: string, allowPrivate: readonly string[]): void {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(bare) && !matchesHost(allowPrivate, bare) && isPrivateAddress(bare)) {
    throw new SsrfBlockedError(bare);
  }
}

/** The error reported for a refused destination; it names the host, never the resolved addresses. */
function ssrfFailure(host: string): Error {
  return toolFailure(`Request to blocked host ${host} rejected by SSRF denylist`);
}

/**
 * A minimal fetch-response-shaped transport function that actually performs
 * the outbound request. `makeHttpRequest()` is transport-agnostic: the
 * default transport calls undici's `fetch` through a dispatcher whose
 * connections use the pinned lookup; `makeHttpRequestViaSandbox()` below
 * supplies a transport that routes the same request through a SandboxAdapter
 * instead (LOU-K2), pinned to the address checked here.
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
 * Default transport: undici's `fetch` with a dedicated `Agent` (dispatcher)
 * whose `connect.lookup` is the pinned lookup (N13a), so every connection,
 * including each redirect target, resolves its host exactly once, refuses a
 * private address and connects to the address it checked. The same Agent
 * scopes `validateSSL: false` to this request rather than to the
 * process-wide NODE_TLS_REJECT_UNAUTHORIZED env var, which is global mutable
 * state and would race under concurrent requests.
 */
function createDirectTransport(
  validateSSL: boolean,
  allowPrivate: readonly string[]
): { transport: HttpTransport; close: () => Promise<void> } {
  // undici is loaded on first request, not at import time (LOU-D19).
  let started = false;
  const load = lazyValue(async () => {
    const { Agent, fetch } = await loadOptionalPeer('undici', () => import('undici'));
    started = true;
    const dispatcher = new Agent({ connect: { rejectUnauthorized: validateSSL, lookup: pinnedLookup({ allowPrivate }) } });
    return { fetch, dispatcher };
  });
  return {
    transport: async (url, init) => {
      const { fetch, dispatcher } = await load();
      return fetch(url, { ...init, dispatcher }) as unknown as Promise<Response>;
    },
    close: async () => {
      // destroy(), not close(): close() waits for a connection attempt the timeout already gave up on.
      if (started) await (await load()).dispatcher.destroy();
    },
  };
}

/**
 * Transport that routes the request through a SandboxAdapter (LOU-K2) via
 * sandboxHttpFetch() rather than calling undici's fetch directly - the
 * actual outbound network call happens inside `sandbox.run()` (a Node
 * subprocess under NoopSandbox; a real isolated command under e.g.
 * SubprocessSandbox) instead of in this process. The host is resolved and
 * checked here, once per hop, and the sandboxed process connects to that
 * checked address instead of resolving the name again (N13a).
 */
function createSandboxTransport(
  sandbox: SandboxAdapter,
  validateSSL: boolean,
  timeoutMs: number,
  allowPrivate: readonly string[]
): HttpTransport {
  return async (url, init) => {
    const [pinned] = await resolvePublicAddresses(new URL(url).hostname, { allowPrivate });
    return sandboxHttpFetch(
      sandbox,
      { url, method: init.method, headers: init.headers, body: init.body, insecureTLS: !validateSSL, pinnedAddress: pinned.address },
      { timeoutMs, signal: init.signal }
    );
  };
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

/** `options.allowPrivate`, lower-cased. */
function allowPrivateOf(options: HttpToolOptions | undefined): string[] {
  return (options?.allowPrivate ?? []).map((pattern) => pattern.toLowerCase());
}

/** The redirect target of a 3xx response, or null/'' when it is not a redirect. */
function redirectLocation(response: Response): string | null {
  return response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
}

/**
 * Issue the request and follow up to `maxRedirects` redirects by hand
 * (`redirect: 'manual'`). Every hop goes through the transport, which
 * applies the pinned SSRF check to its connection.
 */
async function fetchFollowingRedirects(
  transport: HttpTransport,
  url: string,
  init: Parameters<HttpTransport>[1],
  maxRedirects: number,
  allowPrivate: readonly string[]
): Promise<Response> {
  let currentUrl = url;
  let redirectCount = 0;
  let response = await transport(currentUrl, init);
  let location = redirectLocation(response);

  while (location) {
    redirectCount++;
    if (redirectCount > maxRedirects) {
      throw toolFailure(`Exceeded maxRedirects (${maxRedirects})`);
    }
    currentUrl = new URL(location, currentUrl).toString();
    assertLiteralAllowed(new URL(currentUrl).hostname, allowPrivate);
    response = await transport(currentUrl, init);
    location = redirectLocation(response);
  }
  return response;
}

/** Throw on a non-2xx response; otherwise return the body (JSON re-serialized). */
async function readResponseBody(response: Response): Promise<string> {
  if (!response.ok) {
    throw toolFailure(`HTTP ${response.status}: ${response.statusText}`);
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
  const blocked = findSsrfBlockedError(error);
  if (blocked) {
    return ssrfFailure(blocked.host);
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
  const allowPrivate = allowPrivateOf(options);
  try {
    assertLiteralAllowed(new URL(url).hostname, allowPrivate);
  } catch (error) {
    const blocked = findSsrfBlockedError(error);
    throw blocked ? ssrfFailure(blocked.host) : error;
  }

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
      options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
      allowPrivate
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
 * Makes HTTP requests to external APIs, in this process, through undici's
 * fetch with the pinned-lookup dispatcher. Never routed through any
 * SandboxAdapter. This is the implementation behind the HTTP tool's plain
 * `execute()` - see makeHttpRequestViaSandbox() below for the sandboxed path
 * used by `sandboxExecute()`.
 */
export async function makeHttpRequest(args: HttpRequestArgs): Promise<string> {
  const { transport, close } = createDirectTransport(args.options?.validateSSL !== false, allowPrivateOf(args.options));
  return performHttpRequest(args, transport, () => close);
}

/**
 * Same request/redirect/SSRF logic as makeHttpRequest(), but the actual
 * outbound fetch is performed through `sandbox` (LOU-K2) via
 * sandboxHttpFetch() instead of calling undici's fetch directly in this
 * process. The sandboxed process connects to the address checked here.
 */
export async function makeHttpRequestViaSandbox(
  args: HttpRequestArgs,
  sandbox: SandboxAdapter
): Promise<string> {
  const timeoutMs = args.options?.timeout ?? 30000;
  const transport = createSandboxTransport(sandbox, args.options?.validateSSL !== false, timeoutMs + 5000, allowPrivateOf(args.options));
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
