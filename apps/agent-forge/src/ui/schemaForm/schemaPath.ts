import type { JsonSchema, SchemaPath } from './types';

/** Deepest `$ref` chain {@link resolveRef} will follow before giving up. */
const MAX_REF_DEPTH = 8;

/** `#/definitions/name` and `#/$defs/name` — the only ref shapes the catalogs emit. */
const REF_PATTERN = /^#\/(definitions|\$defs)\/([^/]+)$/;

/** `'modelSettings.temperature'`, `'tools.0'` — the key used for errors, labels and hints maps. */
export function pathKey(path: SchemaPath): string {
  return path.map(String).join('.');
}

/** Reads `value` at `path`; `undefined` when any segment is missing or not a container. */
export function getAtPath(value: unknown, path: SchemaPath): unknown {
  let cur: unknown = value;
  for (const segment of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[segment];
  }
  return cur;
}

/**
 * Returns a copy of `value` with `path` set to `next`; never mutates the input
 * (parents share references until the changed branch). `next === undefined`
 * deletes an object key and clears an array slot without changing its length.
 */
export function setAtPath(value: unknown, path: SchemaPath, next: unknown): unknown {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  const existing =
    value !== null && typeof value === 'object' ? (value as Record<string | number, unknown>) : undefined;
  const copy: Record<string | number, unknown> | unknown[] =
    existing == null
      ? typeof head === 'number'
        ? []
        : {}
      : Array.isArray(existing)
        ? [...existing]
        : { ...existing };
  if (rest.length > 0) {
    (copy as Record<string | number, unknown>)[head] = setAtPath(existing?.[head], rest, next);
  } else if (next === undefined) {
    if (Array.isArray(copy)) delete (copy as unknown[])[head as number];
    else delete copy[head];
  } else {
    (copy as Record<string | number, unknown>)[head] = next;
  }
  return copy;
}

/**
 * Resolves a `$ref` (`#/definitions/x`, `#/$defs/x`) against `root`, following
 * chains up to depth 8. Unknown or unresolvable refs return `{}` so the form
 * falls back to a JSON field instead of crashing.
 */
export function resolveRef(root: JsonSchema, schema: JsonSchema): JsonSchema {
  let current = schema;
  for (let depth = 0; depth < MAX_REF_DEPTH && current.$ref != null; depth += 1) {
    const next = lookupRef(root, current.$ref as string);
    if (next == null) return {};
    current = next;
  }
  return current;
}

function lookupRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  const match = REF_PATTERN.exec(ref);
  if (match == null) return undefined;
  const table = match[1] === 'definitions' ? root.definitions : root.$defs;
  return table?.[match[2]];
}
