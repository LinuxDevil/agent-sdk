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
 * Makes HTTP requests to external APIs
 */
async function makeHttpRequest({
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
  try {
    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body && method !== 'GET' ? body : undefined,
    };

    const response = await fetch(url, fetchOptions);

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
    if (error instanceof Error) {
      throw new Error(`HTTP request failed: ${error.message}`);
    }
    throw new Error('HTTP request failed with unknown error');
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
