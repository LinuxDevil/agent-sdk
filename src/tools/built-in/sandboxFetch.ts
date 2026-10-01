/**
 * Shared "route an outbound HTTP call through a SandboxAdapter" helper
 * (LOU-K2).
 *
 * `SandboxAdapter` (src/security/sandboxCore.ts) only exposes `run()` (run a
 * command, capture stdout/stderr/exitCode) and `writeFile()` - there is no
 * generic way to hand it an arbitrary in-process JS closure like `fetch()`.
 * To genuinely route a tool's outbound HTTP call through the adapter (so a
 * real isolation backend like SubprocessSandbox gets a chance to mediate
 * it), the request has to be performed as a subprocess: this module encodes
 * the request as JSON, runs a small Node one-liner via `sandbox.run('node',
 * ['-e', SCRIPT], ...)` that performs the actual `fetch()` and prints the
 * response back as JSON on stdout, and decodes that into a real `Response`.
 *
 * Under NoopSandbox (the default, zero-isolation adapter - see
 * sandboxCore.ts) this still performs the exact same network request as
 * calling `fetch()` in-process would, just via a child `node` process - so
 * behavior is unchanged, only the seam it's routed through changes.
 */

import { SandboxAdapter } from '../../security/sandboxCore';
import { ToolDescriptor } from '../../types';
import { getToolExecute } from '../toolContract';
import { toolFailure } from './toolFailure';

/**
 * The request shape encoded (as base64 JSON, via the SANDBOX_FETCH_REQUEST
 * env var - not argv, so there's no shell-quoting/argv-length concern for
 * arbitrary headers/bodies) and handed to the sandboxed Node script.
 */
export interface SandboxFetchRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * When true, the sandboxed process disables TLS certificate verification
   * for this request (mirrors HttpToolOptions.validateSSL === false in
   * http.ts). Left undefined/false, TLS is verified normally.
   */
  insecureTLS?: boolean;
}

/**
 * Node one-liner run inside the sandbox. Reads the request from
 * SANDBOX_FETCH_REQUEST, performs the real fetch(), and writes exactly one
 * JSON line to stdout - the only thing this module's caller parses.
 * `redirect: 'manual'` so any SSRF/redirect-chasing policy a caller
 * implements (see http.ts's per-hop isBlockedHost check) stays in control
 * of following redirects rather than this script silently doing it.
 */
const SANDBOX_FETCH_SCRIPT = `
const req = JSON.parse(Buffer.from(process.env.SANDBOX_FETCH_REQUEST, 'base64').toString('utf-8'));
if (req.insecureTLS) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
(async () => {
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'manual',
    });
    const text = await res.text();
    const headers = {};
    res.headers.forEach((value, key) => { headers[key] = value; });
    process.stdout.write(JSON.stringify({
      status: res.status,
      statusText: res.statusText,
      headers,
      body: text,
    }));
  } catch (error) {
    process.stderr.write(String((error && error.stack) || error));
    process.exitCode = 1;
  }
})();
`;

export interface SandboxFetchOptions {
  /** Milliseconds before the sandboxed request is killed. Defaults to 30s. */
  timeoutMs?: number;
  /**
   * Cancels the request (LOU-U17). An already-aborted signal rejects without
   * running anything in the sandbox; an abort mid-flight rejects promptly
   * with an `AbortError` and is also handed to `sandbox.run()` so an adapter
   * that supports it can kill the sandboxed process.
   */
  signal?: AbortSignal;
}

/** The `AbortError`-shaped rejection reported when the caller cancels. */
function sandboxAbortError(url: string): Error {
  const error = new Error(`Sandboxed HTTP request to ${url} was aborted`);
  error.name = 'AbortError';
  return error;
}

/** Races `pending` against `signal`, rejecting with an AbortError as soon as it aborts. */
function rejectOnAbort<T>(pending: Promise<T>, signal: AbortSignal | undefined, url: string): Promise<T> {
  if (!signal) {
    return pending;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(sandboxAbortError(url));
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Performs `request` as a real outbound HTTP call routed through
 * `sandbox.run()`, and resolves with a real `Response` built from the
 * sandboxed process's JSON stdout - so callers can keep using the ordinary
 * `Response` API (`.ok`, `.status`, `.headers`, `.text()`, `.json()`).
 */
export async function sandboxHttpFetch(
  sandbox: SandboxAdapter,
  request: SandboxFetchRequest,
  options: SandboxFetchOptions = {}
): Promise<Response> {
  const { signal } = options;
  if (signal?.aborted) {
    throw sandboxAbortError(request.url);
  }
  const encoded = Buffer.from(JSON.stringify(request), 'utf-8').toString('base64');
  const timeoutMs = options.timeoutMs ?? 30000;

  const result = await rejectOnAbort(
    sandbox.run('node', ['-e', SANDBOX_FETCH_SCRIPT], {
      env: { SANDBOX_FETCH_REQUEST: encoded },
      timeoutMs,
      signal,
    }),
    signal,
    request.url
  );

  if (result.exitCode !== 0) {
    throw toolFailure(
      `Sandboxed HTTP request to ${request.url} failed: ${result.stderr || `exit code ${result.exitCode}`}`
    );
  }

  let parsed: { status: number; statusText: string; headers: Record<string, string>; body: string };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw toolFailure(`Sandboxed HTTP request to ${request.url} returned unparsable output: ${result.stdout}`);
  }

  return new Response(parsed.body, {
    status: parsed.status,
    statusText: parsed.statusText,
    headers: parsed.headers,
  });
}

/**
 * Normalizes a fetch-style `HeadersInit` (plain object, `Headers`, or
 * `[key, value][]`) into a plain `Record<string, string>` for encoding.
 */
function normalizeHeaders(headers?: HeadersInit): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

/** True for the `fetch(url)` call forms; false for `fetch(request)`. */
function isUrlInput(input: RequestInfo | URL): input is string | URL {
  return typeof input === 'string' || input instanceof URL;
}

/** The method a `fetch(input, init)` call would use: init, then Request, then GET. */
function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  return init?.method ?? (isUrlInput(input) ? undefined : input.method) ?? 'GET';
}

/** Translate a global-`fetch`-style call into a SandboxFetchRequest. */
function toSandboxFetchRequest(input: RequestInfo | URL, init: RequestInit | undefined): SandboxFetchRequest {
  return {
    url: isUrlInput(input) ? String(input) : input.url,
    method: requestMethod(input, init),
    headers: normalizeHeaders(init?.headers),
    body: init?.body != null ? String(init.body) : undefined,
  };
}

/**
 * Swaps `globalThis.fetch` for a sandbox-routed implementation for the
 * duration of `fn()`, restoring the original afterward (even if `fn`
 * throws). This lets tool code that calls the ambient global `fetch`
 * (github.ts, jira.ts) route its real outbound HTTP call through a
 * SandboxAdapter without every call site inside those tools needing to
 * thread a `sandbox` argument through - see GitHubTools.register() /
 * JiraTools.register(), which wrap each tool's `execute()` with this for
 * `sandboxExecute()`, while leaving `execute()` itself untouched (still a
 * real, directly-callable implementation for callers that invoke
 * `descriptor.tool.execute()` directly rather than through
 * executeToolWithSandboxGuard - e.g. examples/ops-pipeline).
 *
 * NOT safe across concurrent calls that each mutate globalThis.fetch at the
 * same time (a second, interleaved withSandboxedFetch() call would restore
 * the wrong original fetch). This codebase executes one tool call at a time
 * within a given AgentExecutor step today; if that changes, per-call fetch
 * injection (like http.ts's dedicated sandboxExecute) is needed instead of
 * a global monkey-patch.
 */
async function withSandboxedFetch<T>(sandbox: SandboxAdapter, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const sandboxedFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    sandboxHttpFetch(sandbox, toSandboxFetchRequest(input, init))) as typeof fetch;

  globalThis.fetch = sandboxedFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * Flags a tool that calls the ambient global `fetch` as requiresSandbox and
 * gives it a sandboxExecute() that runs its original execute() under
 * withSandboxedFetch() (see GitHubTools.register() / JiraTools.register()).
 * execute() itself is left untouched. Descriptors without an execute() are
 * left as-is.
 */
export function routeFetchThroughSandbox(descriptor: ToolDescriptor): void {
  const originalExecute = getToolExecute(descriptor);
  if (!originalExecute) {
    return;
  }
  descriptor.requiresSandbox = true;
  descriptor.sandboxExecute = (args: unknown, sandbox: SandboxAdapter) =>
    withSandboxedFetch(sandbox, async () => originalExecute(args, {} as any));
}
