import { z } from 'zod';
import { tool } from 'ai';
import { isIP } from 'net';
import { promises as dnsPromises } from 'dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { ToolDescriptor } from '../../types';

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
 * Makes HTTP requests to external APIs
 */
export async function makeHttpRequest({
  url,
  method,
  headers,
  body,
  options = {},
}: {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: string;
  options?: HttpToolOptions;
}): Promise<string> {
  const parsedUrl = new URL(url);
  if (await isBlockedHost(parsedUrl.hostname)) {
    throw new Error(`Request to blocked host ${parsedUrl.hostname} rejected by SSRF denylist`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout ?? 30000);

  // Per-request TLS verification is scoped to a dedicated undici Agent
  // (dispatcher) rather than the process-wide NODE_TLS_REJECT_UNAUTHORIZED
  // env var. The env var is global mutable state: toggling it around an
  // await point is a race under concurrent requests, since one in-flight
  // request's TLS setting can leak into another. A per-request dispatcher
  // has no such cross-request interference.
  const dispatcher = new Agent({
    connect: { rejectUnauthorized: options.validateSSL !== false },
  });

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
      dispatcher,
    };

    let currentUrl = url;
    let redirectCount = 0;
    let response = await undiciFetch(currentUrl, fetchOptions);

    while (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      redirectCount++;
      if (redirectCount > (options.maxRedirects ?? 5)) {
        throw new Error(`Exceeded maxRedirects (${options.maxRedirects ?? 5})`);
      }
      currentUrl = new URL(response.headers.get('location')!, currentUrl).toString();
      const redirectHostname = new URL(currentUrl).hostname;
      if (await isBlockedHost(redirectHostname)) {
        throw new Error(`Request to blocked host ${redirectHostname} rejected by SSRF denylist`);
      }
      response = await undiciFetch(currentUrl, fetchOptions);
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      const data = await response.json();
      return JSON.stringify(data);
    } else {
      return await response.text();
    }
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${options.timeout ?? 30000}ms`);
    }
    if (error instanceof Error) {
      throw new Error(`HTTP request failed: ${error.message}`);
    }
    throw new Error('HTTP request failed with unknown error');
  } finally {
    clearTimeout(timeoutId);
    await dispatcher.close();
  }
}

/**
 * Create HTTP Tool
 * Factory function to create an HTTP tool with custom options
 */
export function createHttpTool(options: HttpToolOptions = {}): ToolDescriptor {
  return {
    displayName: 'Make HTTP request',
    tool: tool({
      description: 'Makes HTTP requests to specified URLs with configurable method, headers, and body. Supports GET, POST, PUT, DELETE, and PATCH methods.',
      parameters: z.object({
        url: z.string().describe('The URL to make the request to (must be a valid HTTP/HTTPS URL)'),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).describe('The HTTP method to use'),
        headers: z.record(z.string()).optional().describe('Optional headers to include in the request as key-value pairs'),
        body: z.string().optional().describe('The body of the request. For POST/PUT/PATCH, this should be a JSON string. Not used for GET/DELETE.'),
      }),
      execute: async ({ url, method, headers, body }) => {
        return makeHttpRequest({ url, method, headers, body, options });
      },
    }),
  };
}

/**
 * Default HTTP Tool instance
 */
export const httpTool: ToolDescriptor = createHttpTool();
