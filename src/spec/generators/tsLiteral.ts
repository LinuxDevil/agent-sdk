/**
 * toTsLiteral(): a plain-data value as a TypeScript literal — the printer
 * specToCode() uses for the spec keys createAgent() takes as data. Strings
 * are single-quoted, identifier-safe object keys stay bare, and arrays and
 * objects wrap to one element per line once the inline form would pass 80
 * columns. Browser-safe: string building only, no `node:*` imports.
 */

/** A string that may stay a bare object key: a TypeScript identifier. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The column an inline array/object may fill before it wraps. */
const INLINE_LIMIT = 80;

/** The characters a single-quoted literal cannot hold verbatim. */
function printString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return `'${escaped}'`;
}

/** A non-object value: strings quoted, everything else its JS source form. */
function printScalar(value: unknown): string {
  if (typeof value === 'string') return printString(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'number' && Object.is(value, -0)) return '-0';
  return String(value);
}

/**
 * An object key in a generated literal: bare when `key` is an identifier,
 * single-quoted otherwise ('a-b', '2bad', keys with spaces).
 */
export function tsObjectKey(key: string): string {
  return IDENTIFIER.test(key) ? key : printString(key);
}

/** The one-line form of any value: `{ a: 1 }` / `[1, 2]` for objects and arrays. */
function printInline(value: unknown): string {
  if (typeof value !== 'object' || value === null) return printScalar(value);
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${value.map(printInline).join(', ')}]`;
  }
  const entries = Object.entries(value);
  return entries.length === 0 ? '{}' : `{ ${entries.map(([k, v]) => `${tsObjectKey(k)}: ${printInline(v)}`).join(', ')} }`;
}

/** The wrapped form of an array/object: one element per line at `indent + 2`, closing bracket at `indent`. */
function printBlock(value: object, indent: number): string {
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  if (Array.isArray(value)) {
    const items = value.map((item) => `${inner}${toTsLiteral(item, indent + 2)},`);
    return `[\n${items.join('\n')}\n${pad}]`;
  }
  const entries = Object.entries(value).map(([k, v]) => `${inner}${tsObjectKey(k)}: ${toTsLiteral(v, indent + 2)},`);
  return `{\n${entries.join('\n')}\n${pad}}`;
}

/**
 * `value` as a TypeScript literal whose first line sits at `indent` columns:
 * the inline form when `indent + length` fits in 80 columns, otherwise the
 * wrapped form (scalars never wrap). Deterministic: the same value and
 * indent always print the same text.
 */
export function toTsLiteral(value: unknown, indent: number): string {
  if (typeof value !== 'object' || value === null) return printScalar(value);
  const inline = printInline(value);
  return indent + inline.length <= INLINE_LIMIT ? inline : printBlock(value, indent);
}
