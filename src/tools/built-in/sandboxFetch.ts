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
import { ToolDescriptor, ToolExecutionContext } from '../../types';
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
  /**
   * The address the caller resolved and SSRF-checked for the URL's host
   * (N13a). When set, the sandboxed process connects to exactly this address
   * (with node:http/node:https and a fixed `lookup`; the URL's host still
   * goes in the `Host` header and TLS SNI) instead of resolving the name
   * again, so a DNS-rebinding name cannot swap in a private address between
   * the check and the connection. Left unset, the process uses `fetch()`.
   */
  pinnedAddress?: string;
}

/**
 * Node one-liner run inside the sandbox. Reads the request from
 * SANDBOX_FETCH_REQUEST, performs the real request, and writes exactly one
 * JSON line to stdout - the only thing this module's caller parses.
 * Redirects are never followed here (`redirect: 'manual'`; node:http does
 * not follow them), so any SSRF/redirect-chasing policy a caller implements
 * (see http.ts, which checks every hop) stays in control of following them.
 * With `pinnedAddress` the request goes out through node:http/node:https
 * with a `lookup` that only ever answers that address (N13a).
 */
const SANDBOX_FETCH_SCRIPT = `
const req = JSON.parse(Buffer.from(process.env.SANDBOX_FETCH_REQUEST, 'base64').toString('utf-8'));
if (req.insecureTLS) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const fail = (error) => {
  process.stderr.write(String((error && error.stack) || error));
  process.exitCode = 1;
};
const decode = (buffer, encoding) => {
  const zlib = require('zlib');
  if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(buffer);
  if (encoding === 'deflate') return zlib.inflateSync(buffer);
  if (encoding === 'br') return zlib.brotliDecompressSync(buffer);
  return buffer;
};
const pinnedRequest = () => {
  const url = new URL(req.url);
  const client = url.protocol === 'https:' ? require('https') : require('http');
  const address = req.pinnedAddress;
  const family = address.includes(':') ? 6 : 4;
  const lookup = (_host, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    if (options && options.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
  const headers = Object.assign({}, req.headers);
  if (req.body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-length')) {
    headers['content-length'] = String(Buffer.byteLength(req.body));
  }
  const request = client.request(url, {
    method: req.method,
    headers,
    lookup,
    rejectUnauthorized: !req.insecureTLS,
    agent: false,
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('error', fail);
    res.on('end', () => {
      try {
        const headers = {};
        for (const [key, value] of Object.entries(res.headers)) {
          headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
        }
        const body = decode(Buffer.concat(chunks), String(res.headers['content-encoding'] || '').toLowerCase()).toString('utf-8');
        process.stdout.write(JSON.stringify({ status: res.statusCode, statusText: res.statusMessage || '', headers, body }));
      } catch (error) {
        fail(error);
      }
    });
  });
  request.on('error', fail);
  if (req.body !== undefined) request.write(req.body);
  request.end();
};
if (req.pinnedAddress) {
  pinnedRequest();
} else (async () => {
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
    fail(error);
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
    // sandboxExecute gets no call context, so execute() sees an empty one (as it always has).
    withSandboxedFetch(sandbox, async () => originalExecute(args, {} as ToolExecutionContext));
}
