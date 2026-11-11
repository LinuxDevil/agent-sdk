/** Keys that would grant a tool, permission, secret, host, sandbox setting, approval exemption or model; no harness may carry them (R13). */
export const FORBIDDEN_HARNESS_KEYS = ['permissions', 'tools', 'secrets', 'sandbox', 'approvals', 'mcpServers', 'hooks', 'model', 'provider', 'network'] as const;

/** Keys that would name the execution process; they live in `page.json`, never in a harness (R18). */
export const FORBIDDEN_EXECUTION_KEYS = ['execution', 'workflow', 'goal', 'steps', 'lead', 'delegates'] as const;

/** A set of forbidden keys and the error each one gives; `at` is the formatted path, for example `harness.platform.tools`. */
export interface ForbiddenKeyRule {
  /** The forbidden keys, matched ignoring case, whitespace, `-`, `_` and invisible characters. */
  keys: readonly string[];
  /** The error text for a key found at `at`. */
  message: (at: string, key: string) => string;
}

/** One error a forbidden key or an unscannable value produces. */
export interface ForbiddenKeyError {
  /** Path from the document root to the key or value. */
  path: (string | number)[];
  /** The error text, naming the path and the rule, or why the value could not be scanned. */
  message: string;
}

/** A scan's errors and the plain-data copy of exactly what it walked; validate `data`, never the original value. */
export interface ForbiddenKeyCheck {
  /** Forbidden keys and unscannable values, unscannable first, each in document order. */
  errors: ForbiddenKeyError[];
  /** A plain JSON copy built from the values the scan read. */
  data: unknown;
}

/** The R13 and R18 rules for harness-shaped documents. */
export const HARNESS_KEY_RULES: readonly ForbiddenKeyRule[] = [
  { keys: FORBIDDEN_HARNESS_KEYS, message: (at, key) => `${at}: harnesses describe the task; the runtime enforces ${key} (R13)` },
  { keys: FORBIDDEN_EXECUTION_KEYS, message: (at) => `${at}: a harness says what, not how; execution lives in page.json (R18)` },
];

/** Where a harness embeds JSON Schemas whose property names are data, not keys. */
export const HARNESS_JSON_SCHEMA_PATHS: readonly string[] = ['inputs.schema', 'outputs.schema'];

const MAX_SCAN_DEPTH = 64;
const SCHEMA_VALUED_NAME_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);
const NAME_LIST_MAPS = new Set(['dependentRequired', 'dependencies']);
const SCHEMA_INSTANCE_VALUES = new Set(['default', 'const', 'examples', 'enum']);
const NOT_PLAIN = 'must be plain JSON data: no class instances, Maps, inherited properties or getters';
const UNREADABLE = 'must be plain JSON data: it could not be read';

type Mode = 'plain' | 'schema';
type Path = (string | number)[];

interface Hit {
  readonly path: Path;
  readonly rule: ForbiddenKeyRule;
  readonly key: string;
}

interface Walk {
  readonly lookup: ReadonlyMap<string, { rule: ForbiddenKeyRule; key: string }>;
  readonly schemaPaths: ReadonlySet<string>;
  readonly hits: Hit[];
  readonly unscannable: { path: Path; reason: string }[];
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
  const isArray = Array.isArray(value);
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (isArray && name === 'length') continue;
    if (!('value' in descriptor)) {
      walk.unscannable.push({ path: [...path, name], reason: NOT_PLAIN });
      return undefined;
    }
    entries.push([isArray && /^\d+$/.test(name) ? Number(name) : name, descriptor.value]);
  }
  return entries;
}

function setCopy(copy: object, name: string | number, value: unknown): void {
  Object.defineProperty(copy, name, { value, enumerable: true, writable: true, configurable: true });
}

function visitNameMap(walk: Walk, keyword: string, path: Path, map: object, depth: number): unknown {
  const copy = {};
  for (const [name, sub] of ownEntries(walk, path, map) ?? []) {
    const childPath = [...path, name];
    setCopy(copy, name, isNameValue(keyword, sub) ? visit(walk, 'schema', childPath, sub, depth + 1) : visitEntry(walk, 'schema', childPath, sub, depth));
  }
  return copy;
}

function visitEntry(walk: Walk, mode: Mode, childPath: Path, child: unknown, depth: number): unknown {
  const key = childPath[childPath.length - 1];
  if (typeof key === 'number') return visit(walk, mode, childPath, child, depth + 1);
  const listed = walk.lookup.get(canonicalKey(key));
  if (listed !== undefined) walk.hits.push({ path: childPath, ...listed });
  if (mode === 'schema' && (SCHEMA_VALUED_NAME_MAPS.has(key) || NAME_LIST_MAPS.has(key)) && isRecord(child) && isPlainContainer(child)) {
    return visitNameMap(walk, key, childPath, child, depth + 1);
  }
  return visit(walk, mode === 'schema' && SCHEMA_INSTANCE_VALUES.has(key) ? 'plain' : mode, childPath, child, depth + 1);
}

function visitContainer(walk: Walk, parentMode: Mode, path: Path, value: object, depth: number): unknown {
  if (depth > MAX_SCAN_DEPTH) {
    walk.unscannable.push({ path, reason: `nests deeper than ${MAX_SCAN_DEPTH} levels` });
    return undefined;
  }
  if (!isPlainContainer(value)) {
    walk.unscannable.push({ path, reason: NOT_PLAIN });
    return undefined;
  }
  const mode = modeAt(walk, parentMode, path);
  const copy: object = Array.isArray(value) ? [] : {};
  for (const [name, child] of ownEntries(walk, path, value) ?? []) setCopy(copy, name, visitEntry(walk, mode, [...path, name], child, depth));
  return copy;
}

function visit(walk: Walk, parentMode: Mode, path: Path, value: unknown, depth: number): unknown {
  if (typeof value !== 'object' || value === null) return value;
  try {
    return visitContainer(walk, parentMode, path, value, depth);
  } catch {
    walk.unscannable.push({ path, reason: UNREADABLE });
    return undefined;
  }
}

function formatKeyPath(root: string, path: readonly (string | number)[]): string {
  return path
    .map((segment) => {
      if (typeof segment === 'number') return `[${segment}]`;
      if (/^[A-Za-z_$][\w$]*$/.test(segment)) return `.${segment}`;
      return `[${JSON.stringify(segment).replace(/\p{Cf}/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}]`;
    })
    .reduce((text, part) => text + part, root);
}

/** Scans `value` at any depth for each rule's keys and copies what it read into plain data; names in JSON Schemas at the dotted `jsonSchemaPaths` are data, not keys. */
export function checkForbiddenKeys(value: unknown, rules: readonly ForbiddenKeyRule[], root: string, jsonSchemaPaths: readonly string[] = []): ForbiddenKeyCheck {
  const lookup = new Map(rules.flatMap((rule) => rule.keys.map((key) => [canonicalKey(key), { rule, key }] as const)));
  const walk: Walk = { lookup, schemaPaths: new Set(jsonSchemaPaths), hits: [], unscannable: [] };
  const data = visit(walk, 'plain', [], value, 0);
  const refused = walk.unscannable.map(({ path, reason }) => ({ path, message: `${formatKeyPath(root, path)}: ${reason}` }));
  const forbidden = walk.hits.map(({ path, rule, key }) => ({ path, message: rule.message(formatKeyPath(root, path), key) }));
  return { errors: [...refused, ...forbidden], data };
}

/** The errors `checkForbiddenKeys` gives, unscannable values included. */
export function forbiddenKeyErrors(value: unknown, rules: readonly ForbiddenKeyRule[], root: string, jsonSchemaPaths: readonly string[] = []): ForbiddenKeyError[] {
  return checkForbiddenKeys(value, rules, root, jsonSchemaPaths).errors;
}

/** The R13 and R18 errors for a harness-shaped document, in document order, each worded `<root>.<path>: …`; property names inside `inputs.schema` and `outputs.schema` are data, not keys. */
export function harnessKeyErrors(value: unknown, root = 'harness'): ForbiddenKeyError[] {
  return forbiddenKeyErrors(value, HARNESS_KEY_RULES, root, HARNESS_JSON_SCHEMA_PATHS);
}
