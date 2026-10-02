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
import {
  abortedRequestError,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  HTTP_TOOL_DESCRIPTION,
  httpRequestInput,
  runHttpRequest,
  type HttpMethod,
  type HttpTransport,
} from './httpCore';

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

/** `options.allowPrivate`, lower-cased. */
function allowPrivateOf(options: HttpToolOptions | undefined): string[] {
  return (options?.allowPrivate ?? []).map((pattern) => pattern.toLowerCase());
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
 * The request/redirect logic of ./httpCore.ts with the Node SSRF policy:
 * IP-literal hosts checked here on every hop, names checked by `transport`
 * at connection time. Parameterized by `transport` so it is shared between
 * the direct (unsandboxed) and sandboxed code paths.
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
  return runHttpRequest(
    { url, method, headers, body, signal, timeoutMs, maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS },
    {
      transport,
      checkHop: (hop) => assertLiteralAllowed(hop.hostname, allowPrivate),
      mapError: (error) => toHttpRequestError(error, timeoutMs, signal),
      tooManyRedirects: (max) => toolFailure(`Exceeded maxRedirects (${max})`),
      httpError: (response) => toolFailure(`HTTP ${response.status}: ${response.statusText}`),
      cleanup: getCleanup() ?? undefined,
    }
  );
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
  const timeoutMs = args.options?.timeout ?? DEFAULT_TIMEOUT_MS;
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
    description: HTTP_TOOL_DESCRIPTION,
    input: httpRequestInput,
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
