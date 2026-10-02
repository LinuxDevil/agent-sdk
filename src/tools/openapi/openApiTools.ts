/**
 * `openApiTools()` (N8): an OpenAPI 3.0 / 3.1 document becomes one tool per
 * operation. The document is parsed once here; each tool's `execute` only
 * builds a request, sends it and shapes the response.
 */

import { z, ZodTypeAny } from 'zod';
import { ConfigurationError } from '../../execution/errors';
import { defineTool, type DefinedTool } from '../defineTool';
import { toolFailure } from '../built-in/toolFailure';
import { jsonSchemaToZod } from '../mcp/schema';
import {
  parseDocumentText,
  parseOpenApiDocument,
  toolNameFor,
  type OpenApiOperationInfo,
  type OperationParameter,
  type ParsedOperation,
} from './operations';

export type { OpenApiOperationInfo } from './operations';

export interface OpenApiToolsOptions {
  /** Overrides the document's first `servers` entry. Must be https (http only for localhost, 127.0.0.1, [::1]). */
  baseUrl?: string;
  /** Operation names (operationId, or the derived name) or a predicate; default: all. */
  include?: readonly string[] | ((op: OpenApiOperationInfo) => boolean);
  exclude?: readonly string[];
  /** Default 'mutating': GET, HEAD and OPTIONS run; other methods ask. */
  approval?: 'mutating' | 'always' | 'never' | ((op: OpenApiOperationInfo) => boolean);
  /** Prefix for tool names: '<prefix>__<operation>'. Default: none. */
  prefix?: string;
  /** Sent on every request; a function is called per call. */
  headers?: Record<string, string> | ((op: OpenApiOperationInfo) => Record<string, string> | Promise<Record<string, string>>);
  /** Shorthand for an Authorization: Bearer header. */
  bearerToken?: string | (() => string | Promise<string>);
  /** Parameter values supplied by the application, removed from the model's input (e.g. a tenant id). */
  providedArguments?: Record<string, unknown | ((ctx: { op: OpenApiOperationInfo; toolCallId: string }) => unknown)>;
  /** Per request, in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** The response body is cut at this many characters. Default 50000. */
  maxResponseChars?: number;
  /** Replaces the global `fetch` (tests, proxies). */
  fetch?: typeof fetch;
}

/** What a generated tool returns for every HTTP response. */
export interface OpenApiToolResult {
  status: number;
  statusText: string;
  /** Parsed JSON when the response says JSON, else text; cut at `maxResponseChars`. */
  body: unknown;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_CHARS = 50_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * One tool per operation of an OpenAPI 3.0 / 3.1 document. Mutating operations
 * (every method except GET, HEAD and OPTIONS) ask for approval by default.
 *
 * @param document A parsed document object, a JSON or YAML string, or an https URL (string or `URL`).
 *
 * @example
 * const tools = await openApiTools('https://api.example.com/openapi.json', {
 *   include: ['getOrder', 'refundOrder'],
 *   bearerToken: () => process.env.ORDERS_TOKEN ?? '',
 * });
 * const agent = createAgent({ provider, tools });
 */
export async function openApiTools(document: object | string | URL, options: OpenApiToolsOptions = {}): Promise<DefinedTool[]> {
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { raw, documentUrl } = await loadDocument(document, fetchFn, timeoutMs);
  const parsed = parseOpenApiDocument(raw);
  const baseUrl = resolveBaseUrl(options.baseUrl ?? parsed.serverUrl, documentUrl);
  const operations = selectOperations(parsed.operations, options);
  assertProvidedArgumentsUsed(operations, options.providedArguments);
  assertUniqueNames(operations, options.prefix);

  return operations.map((operation) => buildTool(operation, parsed.document, baseUrl, { ...options, fetch: fetchFn, timeoutMs }));
}

// --- loading -----------------------------------------------------------------

async function loadDocument(
  document: object | string | URL,
  fetchFn: typeof fetch,
  timeoutMs: number
): Promise<{ raw: unknown; documentUrl?: URL }> {
  if (document instanceof URL || (typeof document === 'string' && /^https?:\/\/\S+$/i.test(document.trim()))) {
    const url = assertAllowedUrl(document instanceof URL ? document.href : document.trim(), 'the document URL');
    const response = await fetchDocument(url, fetchFn, timeoutMs);
    return { raw: parseDocumentText(await response.text()), documentUrl: new URL(response.url || url.href) };
  }
  if (typeof document === 'string') return { raw: parseDocumentText(document) };
  return { raw: document };
}

async function fetchDocument(start: URL, fetchFn: typeof fetch, timeoutMs: number): Promise<Response> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetchFn(url.href, {
        redirect: 'manual',
        headers: { accept: 'application/json, application/yaml, text/yaml, */*;q=0.5' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ConfigurationError(`openApiTools: could not fetch the document from ${url.origin}${url.pathname}: ${errorMessage(error)}`, 'document');
    }
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      url = assertAllowedUrl(new URL(location, url).href, 'a redirect of the document URL');
      continue;
    }
    if (!response.ok) {
      throw new ConfigurationError(`openApiTools: fetching the document failed with HTTP ${response.status} ${response.statusText}`, 'document');
    }
    return response;
  }
  throw new ConfigurationError(`openApiTools: the document URL redirected more than ${MAX_REDIRECTS} times`, 'document');
}

/** https only; http is allowed for loopback hosts. No credentials in the URL. */
function assertAllowedUrl(text: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigurationError(`openApiTools: ${what} is not a valid URL: ${JSON.stringify(text)}`, 'baseUrl');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigurationError(
      `openApiTools: ${what} must use https (http is only allowed for localhost, 127.0.0.1 and [::1]); got ${url.protocol}//${url.host}`,
      'baseUrl'
    );
  }
  if (url.username || url.password) {
    throw new ConfigurationError(`openApiTools: ${what} must not contain a user name or password; pass credentials with 'headers' or 'bearerToken'`, 'baseUrl');
  }
  return url;
}

function resolveBaseUrl(candidate: string | undefined, documentUrl: URL | undefined): URL {
  let text = candidate;
  if (text === undefined) {
    if (!documentUrl) {
      throw new ConfigurationError("openApiTools: the document has no 'servers' entry; pass 'baseUrl'", 'baseUrl');
    }
    text = '/';
  }
  const url = assertAllowedUrl(documentUrl ? new URL(text, documentUrl).href : text, 'the base URL');
  url.search = '';
  url.hash = '';
  return url;
}

// --- selection ------------------------------------------------------------------

function selectOperations(all: ParsedOperation[], options: OpenApiToolsOptions): ParsedOperation[] {
  const { include, exclude } = options;
  const matches = (op: OpenApiOperationInfo, names: readonly string[]) => names.includes(op.name) || (op.operationId !== undefined && names.includes(op.operationId));

  if (Array.isArray(include)) {
    const unknown = include.filter((name) => !all.some((o) => matches(o.info, [name])));
    if (unknown.length > 0) {
      throw new ConfigurationError(
        `openApiTools: 'include' names operations the document does not have: ${unknown.join(', ')}. Available: ${all.map((o) => o.info.name).join(', ') || '(none)'}`,
        'include'
      );
    }
    const refused = all.filter((o) => o.unsupported && matches(o.info, include));
    if (refused.length > 0) {
      throw new ConfigurationError(`openApiTools: cannot make a tool from ${refused[0].info.name}: ${refused[0].unsupported}`, 'include');
    }
  }
  return all.filter((o) => {
    if (o.unsupported) return false;
    if (exclude && matches(o.info, exclude)) return false;
    if (include === undefined) return true;
    return typeof include === 'function' ? include(o.info) : matches(o.info, include);
  });
}

function assertUniqueNames(operations: ParsedOperation[], prefix: string | undefined): void {
  const seen = new Map<string, ParsedOperation>();
  for (const operation of operations) {
    const name = toolNameFor(operation.info, prefix);
    const other = seen.get(name);
    if (other) {
      throw new ConfigurationError(
        `openApiTools: two operations produce the tool name '${name}': ${other.info.method} ${other.info.path} and ${operation.info.method} ${operation.info.path}. Give them distinct operationIds, or use 'include' / 'exclude'.`,
        'include'
      );
    }
    seen.set(name, operation);
  }
}

function inputKeys(operation: ParsedOperation): string[] {
  return [...operation.parameters.map((p) => p.key), ...(operation.bodyKey ? [operation.bodyKey] : [])];
}

function assertProvidedArgumentsUsed(operations: ParsedOperation[], provided: OpenApiToolsOptions['providedArguments']): void {
  for (const key of Object.keys(provided ?? {})) {
    if (!operations.some((op) => inputKeys(op).includes(key))) {
      throw new ConfigurationError(
        `openApiTools: 'providedArguments' has '${key}', which is not a parameter of any selected operation (check the spelling, or 'include')`,
        'providedArguments'
      );
    }
  }
}

// --- building a tool ------------------------------------------------------------------

type ResolvedOptions = OpenApiToolsOptions & { fetch: typeof fetch; timeoutMs: number };

function needsApproval(info: OpenApiOperationInfo, approval: OpenApiToolsOptions['approval']): boolean {
  if (approval === 'always') return true;
  if (approval === 'never') return false;
  if (typeof approval === 'function') return approval(info);
  return !READ_METHODS.has(info.method);
}

function buildTool(operation: ParsedOperation, document: Record<string, unknown>, baseUrl: URL, options: ResolvedOptions): DefinedTool {
  const { info } = operation;
  const providedKeys = Object.keys(options.providedArguments ?? {}).filter((key) => inputKeys(operation).includes(key));
  const schema = prune(operation.inputSchema, providedKeys);
  const input: ZodTypeAny = jsonSchemaToZod(schema, document);
  const readOnly = READ_METHODS.has(info.method);

  return defineTool({
    name: toolNameFor(info, options.prefix),
    description: operation.description,
    input: input as z.ZodType<Record<string, unknown>>,
    needsApproval: needsApproval(info, options.approval),
    annotations: readOnly ? { readOnlyHint: true, destructiveHint: false } : { readOnlyHint: false, destructiveHint: info.method === 'DELETE' },
    async execute(args, ctx) {
      const values: Record<string, unknown> = { ...args };
      for (const key of providedKeys) {
        const provided = options.providedArguments?.[key];
        values[key] = typeof provided === 'function' ? await provided({ op: info, toolCallId: ctx.toolCallId }) : provided;
      }
      return sendRequest(operation, values, baseUrl, options, ctx);
    },
  }) as unknown as DefinedTool;
}

function prune(schema: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  if (keys.length === 0) return schema;
  const properties = { ...(schema.properties as Record<string, unknown>) };
  for (const key of keys) delete properties[key];
  const required = (Array.isArray(schema.required) ? (schema.required as string[]) : []).filter((key) => !keys.includes(key));
  return { ...schema, properties, ...(required.length > 0 ? { required } : { required: undefined }) };
}

// --- the request ----------------------------------------------------------------------

/**
 * A whole path segment of `.` or `..` is path navigation even when percent-encoded
 * (URL parsing resolves `%2E%2E`), so it is refused instead of sent.
 */
function encodePathValue(value: unknown, name: string): string {
  const text = Array.isArray(value) ? value.map(scalarText).join(',') : scalarText(value);
  if (text === '.' || text === '..') throw toolFailure(`path parameter '${name}' cannot be '.' or '..'`);
  return encodeURIComponent(text);
}

function scalarText(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

function queryPairs(parameter: OperationParameter, value: unknown): Array<[string, string]> {
  if (Array.isArray(value)) {
    const explode = parameter.explode ?? (parameter.style === undefined || parameter.style === 'form');
    if (explode) return value.map((item): [string, string] => [parameter.name, scalarText(item)]);
    const separator = parameter.style === 'spaceDelimited' ? ' ' : parameter.style === 'pipeDelimited' ? '|' : ',';
    return [[parameter.name, value.map(scalarText).join(separator)]];
  }
  if (typeof value === 'object' && value !== null) {
    if (parameter.style === 'deepObject') {
      return Object.entries(value).map(([key, item]): [string, string] => [`${parameter.name}[${key}]`, scalarText(item)]);
    }
    return [[parameter.name, JSON.stringify(value)]];
  }
  return [[parameter.name, String(value)]];
}

function buildUrl(operation: ParsedOperation, values: Record<string, unknown>, baseUrl: URL): URL {
  let path = operation.info.path;
  const query = new URLSearchParams();
  for (const parameter of operation.parameters) {
    const value = values[parameter.key];
    if (value === undefined || value === null) continue;
    if (parameter.in === 'path') path = path.split(`{${parameter.name}}`).join(encodePathValue(value, parameter.name));
    else if (parameter.in === 'query') for (const [name, text] of queryPairs(parameter, value)) query.append(name, text);
  }
  const url = new URL(baseUrl.href);
  url.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}${path}`;
  url.search = query.toString();
  return url;
}

function parameterHeaders(operation: ParsedOperation, values: Record<string, unknown>, headers: Headers): void {
  const cookies: string[] = [];
  for (const parameter of operation.parameters) {
    const value = values[parameter.key];
    if (value === undefined || value === null) continue;
    if (parameter.in === 'header') headers.set(parameter.name, Array.isArray(value) ? value.map(scalarText).join(',') : scalarText(value));
    if (parameter.in === 'cookie') cookies.push(`${parameter.name}=${encodeURIComponent(scalarText(value))}`);
  }
  if (cookies.length > 0) headers.set('cookie', cookies.join('; '));
}

async function buildHeaders(operation: ParsedOperation, values: Record<string, unknown>, options: ResolvedOptions): Promise<Headers> {
  const headers = new Headers({ accept: 'application/json, text/plain;q=0.9, */*;q=0.5' });
  if (operation.bodyKey && values[operation.bodyKey] !== undefined) headers.set('content-type', 'application/json');
  parameterHeaders(operation, values, headers);

  // Configured credentials are applied last so a model-supplied header never overrides them.
  const configured = typeof options.headers === 'function' ? await options.headers(operation.info) : options.headers;
  for (const [name, value] of Object.entries(configured ?? {})) headers.set(name, value);
  if (options.bearerToken !== undefined) {
    const token = typeof options.bearerToken === 'function' ? await options.bearerToken() : options.bearerToken;
    headers.set('authorization', `Bearer ${token}`);
  }
  return headers;
}

interface PendingRequest {
  url: URL;
  method: string;
  headers: Headers;
  body?: string;
}

/** The request that follows a redirect: 303 (and 301 / 302 after POST) become a bodyless GET. */
function redirectedRequest(request: PendingRequest, status: number, next: URL): PendingRequest {
  if (status === 303 || ((status === 301 || status === 302) && request.method === 'POST')) {
    const headers = new Headers(request.headers);
    headers.delete('content-type');
    return { url: next, method: 'GET', headers };
  }
  return { ...request, url: next };
}

async function fetchOnce(
  request: PendingRequest,
  label: string,
  options: ResolvedOptions,
  signals: { combined: AbortSignal; timeout: AbortSignal; user?: AbortSignal }
): Promise<Response> {
  try {
    return await options.fetch(request.url.href, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: signals.combined,
    });
  } catch (error) {
    if (signals.timeout.aborted && !signals.user?.aborted) throw toolFailure(`${label} timed out after ${options.timeoutMs} ms`);
    throw toolFailure(`${label} failed: ${errorMessage(error)}`);
  }
}

async function sendRequest(
  operation: ParsedOperation,
  values: Record<string, unknown>,
  baseUrl: URL,
  options: ResolvedOptions,
  ctx: { abortSignal?: AbortSignal }
): Promise<OpenApiToolResult> {
  const label = `${operation.info.method} ${operation.info.path}`;
  let request: PendingRequest = {
    url: buildUrl(operation, values, baseUrl),
    method: operation.info.method,
    headers: await buildHeaders(operation, values, options),
    body: operation.bodyKey && values[operation.bodyKey] !== undefined ? JSON.stringify(values[operation.bodyKey]) : undefined,
  };
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signals = { combined: ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, timeout]) : timeout, timeout, user: ctx.abortSignal };

  for (let hop = 0; ; hop++) {
    const response = await fetchOnce(request, label, options, signals);
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || response.status === 304 || !location) {
      return shapeResponse(response, options.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS);
    }
    const next = new URL(location, request.url);
    if (next.origin !== baseUrl.origin) {
      throw toolFailure(`${label} was redirected to ${next.origin}, which is not the configured origin ${baseUrl.origin}; not following (credentials stay on the configured origin)`);
    }
    if (hop >= MAX_REDIRECTS) throw toolFailure(`${label} was redirected more than ${MAX_REDIRECTS} times`);
    request = redirectedRequest(request, response.status, next);
  }
}

async function shapeResponse(response: Response, maxChars: number): Promise<OpenApiToolResult> {
  const text = await response.text();
  const base = { status: response.status, statusText: response.statusText };
  if (text.length > maxChars) {
    return { ...base, body: `${text.slice(0, maxChars)}\n[truncated: ${text.length - maxChars} more characters not shown]` };
  }
  if (text === '') return { ...base, body: null };
  if (/json/i.test(response.headers.get('content-type') ?? '')) {
    try {
      return { ...base, body: JSON.parse(text) };
    } catch {
      // declared JSON but is not: keep the text
    }
  }
  return { ...base, body: text };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
