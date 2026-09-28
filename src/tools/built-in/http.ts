import { z } from 'zod';
import { tool } from 'ai';
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
 */
const BLOCKED_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/,
];

function isBlockedHost(hostname: string): boolean {
  return BLOCKED_RANGES.some((re) => re.test(hostname));
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
  if (isBlockedHost(parsedUrl.hostname)) {
    throw new Error(`Request to blocked host ${parsedUrl.hostname} rejected by SSRF denylist`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout ?? 30000);

  // The runtime HTTP client here is the global `fetch` (undici under the
  // hood in Node), which has no first-class per-request TLS option. There is
  // no undici/https Agent exposed in this codebase to attach
  // `rejectUnauthorized` to, so validateSSL is wired via the Node TLS env
  // var for the duration of this request only, then restored.
  const previousTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (options.validateSSL === false) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  try {
    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body && method !== 'GET' ? body : undefined,
      signal: controller.signal,
      redirect: 'manual',
    };

    let currentUrl = url;
    let redirectCount = 0;
    let response = await fetch(currentUrl, fetchOptions);

    while (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      redirectCount++;
      if (redirectCount > (options.maxRedirects ?? 5)) {
        throw new Error(`Exceeded maxRedirects (${options.maxRedirects ?? 5})`);
      }
      currentUrl = new URL(response.headers.get('location')!, currentUrl).toString();
      const redirectHostname = new URL(currentUrl).hostname;
      if (isBlockedHost(redirectHostname)) {
        throw new Error(`Request to blocked host ${redirectHostname} rejected by SSRF denylist`);
      }
      response = await fetch(currentUrl, fetchOptions);
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
    if (options.validateSSL === false) {
      if (previousTlsRejectUnauthorized === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsRejectUnauthorized;
      }
    }
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
