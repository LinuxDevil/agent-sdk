/** Keys that would grant a tool, permission, secret, host, sandbox setting, approval exemption or model; no harness may carry them (R13). */
export const FORBIDDEN_HARNESS_KEYS = ['permissions', 'tools', 'secrets', 'sandbox', 'approvals', 'mcpServers', 'hooks', 'model', 'provider', 'network'] as const;

/** Keys that would name the execution process; they live in `page.json`, never in a harness (R18). */
export const FORBIDDEN_EXECUTION_KEYS = ['execution', 'workflow', 'goal', 'steps', 'lead', 'delegates'] as const;

/** One forbidden key found in a document. */
export interface ForbiddenKeyHit {
  /** Path from the document root to the key, ending with the key as written. */
  path: (string | number)[];
  /** The listed key it matched. */
  key: string;
}

/** One error a forbidden key produces. */
export interface ForbiddenKeyError {
  /** Path from the document root to the key, ending with the key as written. */
  path: (string | number)[];
  /** The error text, naming the path and R13 or R18. */
  message: string;
}

const SCHEMA_NAME_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);
const SCHEMA_INSTANCE_VALUES = new Set(['default', 'const', 'examples', 'enum']);
const HARNESS_JSON_SCHEMA_PATHS = ['inputs.schema', 'outputs.schema'];

type Mode = 'plain' | 'schema';

interface Walk {
  readonly lookup: ReadonlyMap<string, string>;
  readonly schemaPaths: ReadonlySet<string>;
  readonly hits: ForbiddenKeyHit[];
}

function canonicalKey(key: string): string {
  return key.normalize('NFKC').replace(/[\s\p{Cf}_-]/gu, '').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function modeAt(walk: Walk, mode: Mode, path: (string | number)[]): Mode {
  if (mode === 'schema') return mode;
  return path.every((segment) => typeof segment === 'string') && walk.schemaPaths.has(path.join('.')) ? 'schema' : 'plain';
}

function visitKey(walk: Walk, mode: Mode, path: (string | number)[], key: string, child: unknown): void {
  const childPath = [...path, key];
  const listed = walk.lookup.get(canonicalKey(key));
  if (listed !== undefined) walk.hits.push({ path: childPath, key: listed });
  if (mode === 'schema' && SCHEMA_NAME_MAPS.has(key) && isRecord(child)) {
    for (const [name, sub] of Object.entries(child)) visit(walk, 'schema', [...childPath, name], sub);
    return;
  }
  visit(walk, mode === 'schema' && SCHEMA_INSTANCE_VALUES.has(key) ? 'plain' : mode, childPath, child);
}

function visit(walk: Walk, parentMode: Mode, path: (string | number)[], value: unknown): void {
  const mode = modeAt(walk, parentMode, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(walk, mode, [...path, index], item));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) visitKey(walk, mode, path, key, child);
}

/**
 * Every key in `value`, at any depth and inside arrays, that matches one of `keys` ignoring case, whitespace, `-`, `_` and invisible characters; inside an embedded JSON Schema at one of `jsonSchemaPaths` (dotted, e.g. `inputs.schema`), the names under `properties`, `patternProperties`, `$defs`, `definitions`, `dependentSchemas` and `dependencies` are data names and are not matched, while every keyword and every `default`, `const`, `examples` and `enum` value still is.
 */
export function findForbiddenKeys(value: unknown, keys: readonly string[], jsonSchemaPaths: readonly string[] = []): ForbiddenKeyHit[] {
  const walk: Walk = { lookup: new Map(keys.map((key) => [canonicalKey(key), key])), schemaPaths: new Set(jsonSchemaPaths), hits: [] };
  visit(walk, 'plain', [], value);
  return walk.hits;
}

/** `path` as text after `root`: `.name` for plain keys, `[0]` for array indexes and `["key"]` for any other key, with invisible characters escaped. */
export function formatKeyPath(root: string, path: readonly (string | number)[]): string {
  return path
    .map((segment) => {
      if (typeof segment === 'number') return `[${segment}]`;
      if (/^[A-Za-z_$][\w$]*$/.test(segment)) return `.${segment}`;
      return `[${JSON.stringify(segment).replace(/\p{Cf}/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}]`;
    })
    .reduce((text, part) => text + part, root);
}

/** The R13 and R18 errors for a harness-shaped document, in document order, each worded `<root>.<path>: …`; property names inside `inputs.schema` and `outputs.schema` are data, not keys. */
export function harnessKeyErrors(value: unknown, root = 'harness'): ForbiddenKeyError[] {
  const security = new Set<string>(FORBIDDEN_HARNESS_KEYS);
  return findForbiddenKeys(value, [...FORBIDDEN_HARNESS_KEYS, ...FORBIDDEN_EXECUTION_KEYS], HARNESS_JSON_SCHEMA_PATHS).map(({ path, key }) => ({
    path,
    message: security.has(key)
      ? `${formatKeyPath(root, path)}: harnesses describe the task; the runtime enforces ${key} (R13)`
      : `${formatKeyPath(root, path)}: a harness says what, not how; execution lives in page.json (R18)`,
  }));
}
