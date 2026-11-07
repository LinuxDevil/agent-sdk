import { humanize, schemaType, unionBranches } from './fieldKind';
import { resolveRef } from './schemaPath';
import type { JsonSchema } from './types';
import { validateSchemaValue } from './validate';

/** One labelled member of a `oneOf`/`anyOf` union; `index` is its position in the option list. */
export interface VariantOption {
  index: number;
  label: string;
  schema: JsonSchema;
}

/**
 * The options of a union with a picker label each: `option.title`; else the
 * single required key that no other option requires (`builtin`, `registry`,
 * `file`, …, humanized); else a `const` value of a shared discriminator key
 * (`type: 'cron'` → `'Cron'`); else `Option {n}`.
 */
export function variantOptions(root: JsonSchema, schema: JsonSchema): VariantOption[] {
  const resolved = resolveRef(root, schema);
  const branches = unionBranches(resolved) ?? [];
  const options = branches.map((option) => resolveRef(root, option)).map((schema, index) => ({
    index,
    label: '',
    schema,
  }));
  const discriminators = sharedConstKeys(options.map((o) => o.schema));
  return options.map((option) => ({ ...option, label: optionLabel(option, options, discriminators) }));
}

/**
 * The option a value belongs to: the first with no `validateSchemaValue`
 * issues, else the first whose required keys are all present (a half-filled
 * form still counts), else -1. `undefined` never matches.
 */
export function matchVariant(root: JsonSchema, options: VariantOption[], value: unknown): number {
  if (value === undefined) return -1;
  for (const option of options) {
    if (validateSchemaValue(root, value, option.schema).length === 0) return option.index;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = new Set(Object.keys(value));
    for (const option of options) {
      const required = resolveRef(root, option.schema).required ?? [];
      if (required.every((key) => keys.has(key))) return option.index;
    }
  }
  return -1;
}

/**
 * A fresh value for an option: `const` discriminators set, required strings
 * `''`, numbers `default ?? undefined`, objects `{}`, arrays `[]`. Non-object
 * schemas return their scalar default (`''` for strings) so record values and
 * primitive options get something editable.
 */
export function defaultForSchema(root: JsonSchema, schema: JsonSchema): unknown {
  const resolved = resolveRef(root, schema);
  const branches = unionBranches(resolved);
  if (branches != null) {
    const first = branches[0];
    return first == null ? undefined : defaultForSchema(root, first);
  }
  if (resolved.const !== undefined) return resolved.const;
  if (schemaType(resolved.type) === 'object' || resolved.properties != null) {
    const required = new Set(resolved.required ?? []);
    const obj: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(resolved.properties ?? {})) {
      const child = resolveRef(root, prop);
      if (child.const !== undefined) obj[key] = child.const;
      else if (required.has(key)) obj[key] = scalarDefault(child);
    }
    return obj;
  }
  return scalarDefault(resolved);
}

/**
 * A short summary for a collapsed list item: `name ?? id ?? title ??` the
 * value of the `type` discriminator `??` the first non-empty string property
 * `??` `Item {n}`.
 */
export function itemSummary(value: unknown, index: number): string {
  return summaryOf(value) ?? `Item ${index + 1}`;
}

/** The descriptive string inside `value`, or `undefined` when it has none. */
function summaryOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value !== '' ? value : undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ['name', 'id', 'title']) {
    if (typeof obj[key] === 'string' && obj[key] !== '') return obj[key] as string;
  }
  if (typeof obj.type === 'string' && obj.type !== '') return obj.type;
  return firstString(obj);
}

/** The first non-empty string property value in insertion order. */
function firstString(obj: Record<string, unknown>): string | undefined {
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/** A property default: `''` for strings, `{}` for objects, `[]` or `default` for arrays, else `default ?? enum[0]`. */
function scalarDefault(schema: JsonSchema): unknown {
  const type = schemaType(schema.type);
  if (type === 'string') return '';
  if (type === 'object' || schema.properties != null) return {};
  if (type === 'array') return schema.default ?? [];
  return schema.default ?? schema.enum?.[0];
}

/** Keys that carry a `const` in two or more options with differing values — the shared discriminators. */
function sharedConstKeys(schemas: JsonSchema[]): Set<string> {
  const keys = new Set<string>();
  for (const schema of schemas) {
    for (const key of Object.keys(schema.properties ?? {})) {
      if (keys.has(key)) continue;
      const consts = schemas
        .map((other) => other.properties?.[key]?.const)
        .filter((v) => v !== undefined);
      if (consts.length >= 2 && new Set(consts).size > 1) keys.add(key);
    }
  }
  return keys;
}

function optionLabel(
  option: VariantOption,
  options: VariantOption[],
  discriminators: Set<string>,
): string {
  const { schema } = option;
  if (schema.title != null) return schema.title;
  const others = options.filter((o) => o !== option);
  const unique = (schema.required ?? []).filter((key) =>
    others.every((o) => !(o.schema.required ?? []).includes(key)),
  );
  if (unique.length === 1) return humanize(unique[0]);
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (discriminators.has(key) && prop.const !== undefined) return humanize(String(prop.const));
  }
  return `Option ${option.index + 1}`;
}
