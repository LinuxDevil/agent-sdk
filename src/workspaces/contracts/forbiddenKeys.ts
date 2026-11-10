/** Keys that would grant a tool, permission, secret, host, sandbox setting, approval exemption or model; no harness may carry them (R13). */
export const FORBIDDEN_HARNESS_KEYS = ['permissions', 'tools', 'secrets', 'sandbox', 'approvals', 'mcpServers', 'hooks', 'model', 'provider', 'network'] as const;

/** Keys that would name the execution process; they live in `page.json`, never in a harness (R18). */
export const FORBIDDEN_EXECUTION_KEYS = ['execution', 'workflow', 'goal', 'steps', 'lead', 'delegates'] as const;

const MAX_SCAN_DEPTH = 64;

/** One forbidden key found in a document. */
export interface ForbiddenKeyHit {
  /** Path from the document root to the key, ending with the key as written. */
  path: (string | number)[];
  /** The listed key it matched. */
  key: string;
}

/** A value the scan refused to walk: not plain JSON data, or nested deeper than `MAX_SCAN_DEPTH`. */
export interface UnscannableValue {
  /** Path from the document root to the value. */
  path: (string | number)[];
  /** Why it was refused, without the path. */
  reason: string;
}

/** What one scan found. */
export interface ForbiddenKeyScan {
  /** Forbidden keys, in document order. */
  hits: ForbiddenKeyHit[];
  /** Values that were not walked; a document with any is invalid. */
  unscannable: UnscannableValue[];
}

/** One error a forbidden key or an unscannable value produces. */
export interface ForbiddenKeyError {
  /** Path from the document root to the key or value. */
  path: (string | number)[];
  /** The error text, naming the path and R13, R18 or why the value could not be scanned. */
  message: string;
}

const SCHEMA_VALUED_NAME_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);
const NAME_LIST_MAPS = new Set(['dependentRequired', 'dependencies']);
const SCHEMA_INSTANCE_VALUES = new Set(['default', 'const', 'examples', 'enum']);
const HARNESS_JSON_SCHEMA_PATHS = ['inputs.schema', 'outputs.schema'];
const NOT_PLAIN = 'must be plain JSON data: no class instances, Maps, inherited properties or getters';

type Mode = 'plain' | 'schema';
type Path = (string | number)[];

interface Walk {
  readonly lookup: ReadonlyMap<string, string>;
  readonly schemaPaths: ReadonlySet<string>;
  readonly scan: ForbiddenKeyScan;
}

function canonicalKey(key: string): string {
  return key.normalize('NFKC').replace(/[\s\p{Cf}_-]/gu, '').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainContainer(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return Array.isArray(value) ? proto === Array.prototype : proto === Object.prototype || proto === null;
}

function isNameValue(keyword: string, value: unknown): boolean {
  if (SCHEMA_VALUED_NAME_MAPS.has(keyword) && (isRecord(value) || typeof value === 'boolean')) return true;
  return NAME_LIST_MAPS.has(keyword) && Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function modeAt(walk: Walk, mode: Mode, path: Path): Mode {
  if (mode === 'schema') return mode;
  return path.every((segment) => typeof segment === 'string') && walk.schemaPaths.has(path.join('.')) ? 'schema' : 'plain';
}

function ownEntries(walk: Walk, path: Path, value: object): [string | number, unknown][] | undefined {
  const entries: [string | number, unknown][] = [];
  for (const name of Object.getOwnPropertyNames(value)) {
    if (Array.isArray(value) && name === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !('value' in descriptor)) {
      walk.scan.unscannable.push({ path: [...path, name], reason: NOT_PLAIN });
      return undefined;
    }
    entries.push([Array.isArray(value) && /^\d+$/.test(name) ? Number(name) : name, descriptor.value]);
  }
  return entries;
}

function visitNameMap(walk: Walk, keyword: string, path: Path, map: Record<string, unknown>, depth: number): void {
  const entries = ownEntries(walk, path, map);
  for (const [name, sub] of entries ?? []) {
    const childPath = [...path, name];
    if (isNameValue(keyword, sub)) visit(walk, 'schema', childPath, sub, depth + 1);
    else visitEntry(walk, 'schema', childPath, sub, depth);
  }
}

function visitEntry(walk: Walk, mode: Mode, childPath: Path, child: unknown, depth: number): void {
  const key = childPath[childPath.length - 1];
  if (typeof key === 'number') {
    visit(walk, mode, childPath, child, depth + 1);
    return;
  }
  const listed = walk.lookup.get(canonicalKey(key));
  if (listed !== undefined) walk.scan.hits.push({ path: childPath, key: listed });
  if (mode === 'schema' && (SCHEMA_VALUED_NAME_MAPS.has(key) || NAME_LIST_MAPS.has(key)) && isRecord(child) && isPlainContainer(child)) {
    visitNameMap(walk, key, childPath, child, depth + 1);
    return;
  }
  visit(walk, mode === 'schema' && SCHEMA_INSTANCE_VALUES.has(key) ? 'plain' : mode, childPath, child, depth + 1);
}

function visit(walk: Walk, parentMode: Mode, path: Path, value: unknown, depth: number): void {
  if (typeof value !== 'object' || value === null) return;
  if (depth > MAX_SCAN_DEPTH) {
    walk.scan.unscannable.push({ path, reason: `nests deeper than ${MAX_SCAN_DEPTH} levels` });
    return;
  }
  if (!isPlainContainer(value)) {
    walk.scan.unscannable.push({ path, reason: NOT_PLAIN });
    return;
  }
  const mode = modeAt(walk, parentMode, path);
  for (const [name, child] of ownEntries(walk, path, value) ?? []) visitEntry(walk, mode, [...path, name], child, depth);
}

/** Scans `value` for `keys` at any depth, ignoring case, whitespace, `-`, `_` and invisible characters; under a dotted `jsonSchemaPaths` entry, schema property and definition names are data, not keys. */
export function scanForbiddenKeys(value: unknown, keys: readonly string[], jsonSchemaPaths: readonly string[] = []): ForbiddenKeyScan {
  const walk: Walk = { lookup: new Map(keys.map((key) => [canonicalKey(key), key])), schemaPaths: new Set(jsonSchemaPaths), scan: { hits: [], unscannable: [] } };
  visit(walk, 'plain', [], value, 0);
  return walk.scan;
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
  const { hits, unscannable } = scanForbiddenKeys(value, [...FORBIDDEN_HARNESS_KEYS, ...FORBIDDEN_EXECUTION_KEYS], HARNESS_JSON_SCHEMA_PATHS);
  const refused = unscannable.map(({ path, reason }) => ({ path, message: `${formatKeyPath(root, path)}: ${reason}` }));
  const forbidden = hits.map(({ path, key }) => ({
    path,
    message: security.has(key)
      ? `${formatKeyPath(root, path)}: harnesses describe the task; the runtime enforces ${key} (R13)`
      : `${formatKeyPath(root, path)}: a harness says what, not how; execution lives in page.json (R18)`,
  }));
  return [...refused, ...forbidden];
}
