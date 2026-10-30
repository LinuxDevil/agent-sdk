import { resolveRef } from './schemaPath';
import type { JsonSchema } from './types';

/**
 * Which control {@link FIELD_RENDERERS} uses for a schema. U14 extends this
 * union with `'variant' | 'objectArray' | 'record'`; until then those shapes
 * are `'json'`.
 */
export type FieldKind =
  | 'string'
  | 'text'
  | 'secret'
  | 'enum'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'primitiveArray'
  | 'json';

/** Words that stay uppercase when {@link humanize} builds a label. */
const ACRONYMS: Record<string, string> = {
  api: 'API',
  id: 'ID',
  json: 'JSON',
  mcp: 'MCP',
  ttl: 'TTL',
  url: 'URL',
};

type KindRule = (schema: JsonSchema) => FieldKind;

const JSON_KIND: KindRule = () => 'json';

/** Per-`type` kind rules, dispatched from {@link fieldKind} so it stays a flat lookup. */
const KIND_BY_TYPE: Record<string, KindRule> = {
  string: stringKind,
  integer: () => 'integer',
  number: () => 'number',
  boolean: () => 'boolean',
  object: objectKind,
  array: arrayKind,
};

/**
 * Picks the field kind for a (already `$ref`-resolved) schema. First match
 * wins: `enum` beats everything; a `type` array keeps only its single
 * non-`'null'` member; anything unrecognized falls back to `'json'` so the
 * value stays editable as raw JSON instead of disappearing.
 */
export function fieldKind(schema: JsonSchema): FieldKind {
  if (schema.enum != null) return 'enum';
  const type = schemaType(schema.type);
  if (type == null) return 'json';
  return (KIND_BY_TYPE[type] ?? JSON_KIND)(schema);
}

/** All declared types with `'null'` stripped (`['string','null']` → `['string']`). */
export function schemaTypes(type: JsonSchema['type']): string[] {
  const list = Array.isArray(type) ? type : type != null ? [type] : [];
  return list.filter((t) => t !== 'null');
}

/** The single remaining type after stripping `'null'`; `undefined` for none or a real union. */
export function schemaType(type: JsonSchema['type']): string | undefined {
  const list = schemaTypes(type);
  return list.length === 1 ? list[0] : undefined;
}

/** `'maxOutputTokens'` → `'Max output tokens'`; `'mcpServers'` → `'MCP servers'`; `'ttlMs'` → `'TTL ms'`. */
export function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word, i) => {
      const lower = word.toLowerCase();
      return ACRONYMS[lower] ?? (i === 0 ? lower[0].toUpperCase() + lower.slice(1) : lower);
    })
    .join(' ');
}

function stringKind(schema: JsonSchema): FieldKind {
  if (schema['x-widget'] === 'secret') return 'secret';
  if (schema['x-widget'] === 'textarea' || (schema.maxLength ?? 0) > 200) return 'text';
  return 'string';
}

function objectKind(schema: JsonSchema): FieldKind {
  return schema.properties != null && schema.oneOf == null && schema.anyOf == null ? 'object' : 'json';
}

function arrayKind(schema: JsonSchema): FieldKind {
  const items = schema.items == null ? undefined : resolveRef(schema, schema.items);
  const itemType = items == null ? undefined : schemaType(items.type);
  const primitive = itemType === 'string' || itemType === 'number' || itemType === 'integer';
  return primitive && items?.enum == null ? 'primitiveArray' : 'json';
}
