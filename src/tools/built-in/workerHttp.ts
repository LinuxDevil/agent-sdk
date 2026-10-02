/**
 * `http_request` for Cloudflare Workers (M3a): the Node tool's name, input
 * and request logic (./httpCore.ts) over the platform `fetch()`, limited to
 * the host names the deployer listed.
 *
 * Why an allowlist instead of the Node tool's private-address check: a
 * Worker's `fetch()` resolves names inside Cloudflare's network and gives no
 * hook to see or pin the address, so where a host name connects cannot be
 * checked here (see docs/deployment.md). What a Worker can check is the URL,
 * so every URL, the first and each redirect target, must:
 *  1. use `http:` or `https:`;
 *  2. not have an IP-literal host, even a listed one (there is no address
 *     check, so only names are allowed);
 *  3. have a host matching the allowlist (`api.example.com`, or
 *     `*.example.com` for subdomains only). An empty allowlist refuses every
 *     request.
 * The allowlist therefore moves the trust to the deployer: a listed name that
 * resolves to an internal address is reached. A model cannot pick an
 * arbitrary host (or a DNS-rebinding one) because only listed names pass.
 *
 * Node-free: the Worker bundle includes this file.
 */

import { ToolDescriptor } from '../../types';
import { isHostPattern, matchesHost } from '../../security/hostPattern';
import { defineTool } from '../defineTool';
import { toolFailure } from './toolFailure';
import { SDKError } from '../../execution/errors';
import {
  abortedRequestError,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  HTTP_TOOL_DESCRIPTION,
  httpRequestInput,
  ipFamily,
  runHttpRequest,
} from './httpCore';

/** The Worker binding that holds the comma-separated host allowlist of `http_request`. */
export const HTTP_ALLOW_BINDING = 'LOUSHO_HTTP_ALLOW';

/** Options of {@link createWorkerHttpTool}. */
export interface WorkerHttpToolOptions {
  /**
   * Host patterns the tool may reach: an exact name (`api.github.com`) or a
   * `*.` wildcard (`*.example.com`, subdomains only). Empty: every request is
   * refused. An entry that is not a host pattern fails every request.
   */
  allow: readonly string[];
  /** Time limit for the whole request, redirects included. Default 30 000 ms. */
  timeout?: number;
  /** Redirects followed before giving up. Each hop is checked again. Default 5. */
  maxRedirects?: number;
  /** @internal Test hook: performs the request instead of `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/** Splits a `LOUSHO_HTTP_ALLOW` value (`api.github.com, *.example.com`) into its entries. A non-string is an empty list. */
export function parseHostAllowList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function refused(message: string): SDKError {
  return toolFailure(`Request refused: ${message}`);
}

/** Throws a tool failure unless `url` may be requested under `allow` (already lower-cased and valid). */
function assertAllowed(url: URL, allow: readonly string[]): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw refused(`only http: and https: URLs are allowed, not ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  if (bare.includes(':') || ipFamily(bare) !== 0) {
    throw refused(`${host} is an IP address; on Cloudflare Workers only listed host names can be requested`);
  }
  if (allow.length === 0) {
    throw refused(`no hosts are allowed; list them in the ${HTTP_ALLOW_BINDING} binding (for example "api.example.com,*.example.com")`);
  }
  if (!matchesHost(allow, host)) {
    throw refused(`host ${host} is not in the allowlist (${HTTP_ALLOW_BINDING})`);
  }
}

/** Parses `url`, reporting an unparsable one as a tool failure. */
function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw refused(`invalid URL ${url}`);
  }
}

/** Map whatever the request threw to a tool failure; a caller's cancellation stays an `AbortError`. */
function toWorkerHttpError(error: unknown, timeoutMs: number, signal: AbortSignal | undefined): Error {
  if (signal?.aborted) return abortedRequestError();
  if (error instanceof SDKError && error.code === 'LOUSHO_TOOL_EXECUTION_FAILED') return error;
  if (error instanceof Error && error.name === 'AbortError') return toolFailure(`Request timed out after ${timeoutMs}ms`);
  return toolFailure(`HTTP request failed: ${error instanceof Error ? error.message : String(error)}`, error);
}

/**
 * The `http_request` tool for Cloudflare Workers: same name and input as
 * `createHttpTool()`, requests only to the host names in `allow`, over the
 * platform `fetch()` (which always validates TLS). Failures, including every
 * refusal, are tool failures the model reads.
 */
export function createWorkerHttpTool(options: WorkerHttpToolOptions): ToolDescriptor {
  const allow = options.allow.map((pattern) => pattern.toLowerCase());
  const invalid = allow.filter((pattern) => !isHostPattern(pattern));
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  return defineTool({
    name: 'http_request',
    displayName: 'Make HTTP request',
    description: `${HTTP_TOOL_DESCRIPTION} Only the hosts this deployment allows can be reached.`,
    input: httpRequestInput,
    execute: async ({ url, method, headers, body }, ctx) => {
      if (invalid.length > 0) {
        throw toolFailure(
          `Request refused: invalid host pattern ${invalid.map((pattern) => `'${pattern}'`).join(', ')} in ${HTTP_ALLOW_BINDING}; ` +
            'use host names such as api.example.com or wildcards such as *.example.com'
        );
      }
      assertAllowed(parseUrl(url), allow);
      const signal = ctx?.abortSignal;
      return runHttpRequest(
        { url, method, headers, body, signal, timeoutMs, maxRedirects },
        {
          transport: (target, init) => fetchImpl(target, init),
          checkHop: (hop) => assertAllowed(hop, allow),
          mapError: (error) => toWorkerHttpError(error, timeoutMs, signal),
          tooManyRedirects: (max) => toolFailure(`Exceeded maxRedirects (${max})`),
          httpError: (response) => toolFailure(`HTTP ${response.status}: ${response.statusText}`),
        }
      );
    },
  });
}
