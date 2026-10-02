/**
 * OpenAPI document -> list of operations (N8).
 *
 * Parses a 3.0 / 3.1 document once, resolves `$ref`s that point at
 * parameters, request bodies and path items' parameters, and describes each
 * operation as the JSON Schema of its tool input plus the instructions for
 * building the HTTP request. Nothing here touches the network.
 */

import { parse as parseYaml } from 'yaml';
import { ConfigurationError } from '../../execution/errors';

type Json = Record<string, unknown>;

/** Description of one API operation, as shown to `include`, `approval`, `headers` and `providedArguments`. */
export interface OpenApiOperationInfo {
  /** The tool name without the `prefix__` part: the sanitized `operationId`, or `<method>_<path>`. */
  name: string;
  /** The document's `operationId`, when it has one. */
  operationId?: string;
  /** Upper-case HTTP method. */
  method: string;
  /** Path template, e.g. `/orders/{orderId}`. */
  path: string;
  summary?: string;
  tags: string[];
}

export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

/** One parameter of an operation: where it goes and which input key carries it. */
export interface OperationParameter {
  /** Key in the tool's input object. */
  key: string;
  /** Name on the wire. */
  name: string;
  in: ParameterLocation;
  required: boolean;
  style?: string;
  explode?: boolean;
}

export interface ParsedOperation {
  info: OpenApiOperationInfo;
  description: string;
  parameters: OperationParameter[];
  /** Input key of the JSON request body, when the operation takes one. */
  bodyKey?: string;
  /** JSON Schema of the tool input; `$ref`s inside point into the document. */
  inputSchema: Json;
  /** Why the operation cannot become a tool (for example a multipart body). */
  unsupported?: string;
}

export interface ParsedDocument {
  /** The normalized document: the root every `$ref` in `inputSchema` resolves against. */
  document: Json;
  operations: ParsedOperation[];
  /** `servers[0].url` with variables replaced by their defaults, when present. */
  serverUrl?: string;
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const;
const IGNORED_HEADER_PARAMETERS = new Set(['accept', 'content-type', 'authorization', 'host', 'content-length']);
const MAX_DESCRIPTION_CHARS = 1000;
const MAX_TOOL_NAME = 64;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse a JSON or YAML string into a document object. */
export function parseDocumentText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // not JSON: try YAML
  }
  try {
    return parseYaml(trimmed);
  } catch (error) {
    throw new ConfigurationError(
      `openApiTools: the document is neither valid JSON nor valid YAML (${error instanceof Error ? error.message : String(error)})`,
      'document'
    );
  }
}

/** Validate the version and parse every operation of an OpenAPI 3.0 / 3.1 document. */
export function parseOpenApiDocument(input: unknown): ParsedDocument {
  if (!isRecord(input)) {
    throw new ConfigurationError('openApiTools: the document must be an OpenAPI 3.0 or 3.1 object, a JSON or YAML string, or an https URL', 'document');
  }
  if ('swagger' in input) {
    throw new ConfigurationError(
      `openApiTools: this is a Swagger ${String(input.swagger)} document; only OpenAPI 3.0 and 3.1 are supported. Convert it first (for example with swagger2openapi) and pass the result.`,
      'document'
    );
  }
  const version = input.openapi;
  if (typeof version !== 'string' || !/^3\.[01](\.|$)/.test(version)) {
    throw new ConfigurationError(
      `openApiTools: unsupported or missing "openapi" version ${JSON.stringify(version)}; only OpenAPI 3.0 and 3.1 are supported`,
      'document'
    );
  }
  assertNoRemoteRefs(input);
  const document = normalize(input) as Json;
  const paths = isRecord(document.paths) ? document.paths : {};
  const operations: ParsedOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (isRecord(operation)) operations.push(parseOperation(document, path, method, item, operation));
    }
  }
  return { document, operations, serverUrl: serverUrlOf(document) };
}

// --- $ref handling -------------------------------------------------------------

function assertNoRemoteRefs(node: unknown, path = '#'): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNoRemoteRefs(item, `${path}/${index}`));
  } else if (isRecord(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && !value.startsWith('#')) {
        throw new ConfigurationError(
          `openApiTools: remote $ref ${JSON.stringify(value)} at ${path} is not supported. Bundle the document so every $ref is local ("#/components/...").`,
          'document'
        );
      }
      assertNoRemoteRefs(value, `${path}/${key}`);
    }
  }
}

/**
 * Deep copy that rewrites OpenAPI 3.0 `nullable: true` into JSON Schema
 * (`type: [t, 'null']`, or `anyOf` with null around a `$ref`).
 */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (!isRecord(node)) return node;
  const copy: Json = {};
  for (const [key, value] of Object.entries(node)) copy[key] = normalize(value);
  if (copy.nullable === true) {
    delete copy.nullable;
    if (typeof copy.type === 'string') copy.type = [copy.type, 'null'];
    else if (Array.isArray(copy.type)) copy.type = copy.type.includes('null') ? copy.type : [...copy.type, 'null'];
    else if (typeof copy.$ref === 'string') {
      const { $ref, ...rest } = copy;
      return { ...rest, anyOf: [{ $ref }, { type: 'null' }] };
    }
    if (Array.isArray(copy.enum) && !copy.enum.includes(null)) copy.enum = [...copy.enum, null];
  }
  return copy;
}

function resolveLocalRef(document: Json, ref: string): unknown {
  let node: unknown = document;
  for (const raw of ref.slice(2).split('/')) {
    const segment = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isRecord(node)) return undefined;
    node = node[segment];
  }
  return node;
}

/** Follow `$ref` chains (parameters, request bodies) until a concrete object. */
function deref(document: Json, value: unknown, where: string): Json | undefined {
  let current = value;
  for (let hops = 0; hops < 16; hops++) {
    if (!isRecord(current)) return undefined;
    if (typeof current.$ref !== 'string') return current;
    const target = resolveLocalRef(document, current.$ref);
    if (target === undefined) {
      throw new ConfigurationError(`openApiTools: ${where} refers to ${current.$ref}, which does not exist in the document`, 'document');
    }
    current = target;
  }
  throw new ConfigurationError(`openApiTools: ${where} has a $ref chain that does not end`, 'document');
}

// --- operations ------------------------------------------------------------

function sanitize(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]+/g, '_');
}

function derivedName(method: string, path: string): string {
  const pathPart = sanitize(path.replace(/[{}]/g, '')).replace(/^_+|_+$/g, '');
  return `${method}${pathPart ? `_${pathPart}` : ''}`;
}

/** Final tool name for an operation: `<prefix>__<name>`, at most 64 characters. */
export function toolNameFor(info: OpenApiOperationInfo, prefix?: string): string {
  const head = prefix ? `${sanitize(prefix)}__` : '';
  return `${head}${info.name}`.slice(0, MAX_TOOL_NAME);
}

function withDescription(schema: Json, description: unknown): Json {
  return typeof description === 'string' && description !== '' && typeof schema.description !== 'string' ? { ...schema, description } : schema;
}

function operationInfo(path: string, method: string, operation: Json): OpenApiOperationInfo {
  const operationId = typeof operation.operationId === 'string' && operation.operationId !== '' ? operation.operationId : undefined;
  return {
    name: (operationId ? sanitize(operationId) : derivedName(method, path)).slice(0, MAX_TOOL_NAME),
    ...(operationId ? { operationId } : {}),
    method: method.toUpperCase(),
    path,
    ...(typeof operation.summary === 'string' ? { summary: operation.summary } : {}),
    tags: Array.isArray(operation.tags) ? operation.tags.filter((t): t is string => typeof t === 'string') : [],
  };
}

/** Operation-level parameters override path-level ones with the same name and location. */
function declaredParameters(document: Json, item: Json, operation: Json, where: string): Json[] {
  const declared = new Map<string, Json>();
  for (const list of [item.parameters, operation.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const parameter = deref(document, entry, `a parameter of ${where}`);
      if (parameter && typeof parameter.name === 'string' && typeof parameter.in === 'string') {
        declared.set(`${parameter.in}:${parameter.name}`, parameter);
      }
    }
  }
  return [...declared.values()];
}

function parameterSchema(parameter: Json): Json {
  if (isRecord(parameter.schema)) return parameter.schema;
  const content = isRecord(parameter.content) ? Object.values(parameter.content).find(isRecord) : undefined;
  return isRecord(content?.schema) ? content.schema : {};
}

interface ParameterSet {
  properties: Json;
  required: string[];
  parameters: OperationParameter[];
}

function collectParameters(declared: Json[]): ParameterSet {
  const set: ParameterSet = { properties: {}, required: [], parameters: [] };
  const usedKeys = new Set<string>();
  for (const parameter of declared) {
    const name = parameter.name as string;
    const location = parameter.in as ParameterLocation;
    if (!['path', 'query', 'header', 'cookie'].includes(location)) continue;
    if (location === 'header' && IGNORED_HEADER_PARAMETERS.has(name.toLowerCase())) continue;
    const key = usedKeys.has(name) ? `${location}_${name}` : name;
    usedKeys.add(key);
    const required = location === 'path' || parameter.required === true;
    set.properties[key] = withDescription(parameterSchema(parameter), parameter.description);
    if (required) set.required.push(key);
    set.parameters.push({
      key,
      name,
      in: location,
      required,
      ...(typeof parameter.style === 'string' ? { style: parameter.style } : {}),
      ...(typeof parameter.explode === 'boolean' ? { explode: parameter.explode } : {}),
    });
  }
  return set;
}

/** The JSON request body, if the operation has one: its input key and schema, or why it is unsupported. */
function jsonBody(body: Json | undefined, taken: Set<string>): { key?: string; schema?: Json; required?: boolean; unsupported?: string } {
  if (!body) return {};
  const content = isRecord(body.content) ? body.content : {};
  const jsonType = Object.keys(content).find((type) => /^application\/(.+\+)?json\b/i.test(type));
  if (!jsonType) {
    const types = Object.keys(content);
    return types.length > 0 ? { unsupported: `its request body is ${types.join(', ')}; only application/json bodies are supported` } : {};
  }
  const media = content[jsonType];
  const schema = isRecord(media) && isRecord(media.schema) ? media.schema : {};
  return { key: taken.has('body') ? 'requestBody' : 'body', schema: withDescription(schema, body.description), required: body.required === true };
}

function describeOperation(info: OpenApiOperationInfo, operation: Json): string {
  const text = [operation.summary, operation.description]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join('\n\n');
  return `${text.slice(0, MAX_DESCRIPTION_CHARS)}${text ? '\n\n' : ''}${info.method} ${info.path}`;
}

function parseOperation(document: Json, path: string, method: string, item: Json, operation: Json): ParsedOperation {
  const info = operationInfo(path, method, operation);
  const where = `${info.method} ${path}`;
  const { properties, required, parameters } = collectParameters(declaredParameters(document, item, operation, where));
  const body = jsonBody(deref(document, operation.requestBody, `the request body of ${where}`), new Set(parameters.map((p) => p.key)));
  if (body.key && body.schema) {
    properties[body.key] = body.schema;
    if (body.required) required.push(body.key);
  }
  return {
    info,
    description: describeOperation(info, operation),
    parameters,
    ...(body.key ? { bodyKey: body.key } : {}),
    inputSchema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
    ...(body.unsupported ? { unsupported: body.unsupported } : {}),
  };
}

function serverUrlOf(document: Json): string | undefined {
  const servers = document.servers;
  if (!Array.isArray(servers) || !isRecord(servers[0]) || typeof servers[0].url !== 'string') return undefined;
  const variables = isRecord(servers[0].variables) ? servers[0].variables : {};
  return servers[0].url.replace(/\{([^}]+)\}/g, (whole, name: string) => {
    const variable = variables[name];
    return isRecord(variable) && variable.default !== undefined ? String(variable.default) : whole;
  });
}
