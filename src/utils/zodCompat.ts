/**
 * zod 3 / zod 4 compatibility (LOU-D29). The SDK accepts schemas from either
 * major (and any Standard Schema that can describe itself as JSON Schema),
 * and its own schemas are built with whichever `zod` is installed.
 * `zod/v4/core` exists in both `zod@^3.25` and `zod@4`.
 */

import { z } from 'zod';
import { toJSONSchema, type $ZodType } from 'zod/v4/core';

/** One validation problem, as zod 3, zod 4 and Standard Schema report it. */
export interface SchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

/** A schema's `safeParse`, typed so that both majors' schemas fit. */
export interface SafeParser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly SchemaIssue[] } };
}

type StandardResult<Output> = { readonly value: Output; readonly issues?: undefined } | { readonly issues: ReadonlyArray<SchemaIssue> };

/**
 * A Standard Schema (https://standardschema.dev): zod 3.25+ and zod 4
 * schemas are ones. `defineTool({ input })` takes any of them whose JSON
 * Schema can be derived (see {@link schemaToJsonSchema}).
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

/** The parsed (output) type of a schema of either zod major, or of any Standard Schema. */
export type InferSchemaOutput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['output'];

/** A schema with zod 3's internals (`_def.typeName`). */
function isZod3Schema(value: unknown): boolean {
  const def = (value as { _def?: { typeName?: unknown } } | null)?._def;
  return typeof def?.typeName === 'string' && !isZod4Schema(value);
}

/** A schema with zod 4's internals (`_zod`), from `zod@4` or `zod/v4` of `zod@3.25`. */
export function isZod4Schema(value: unknown): value is $ZodType {
  return typeof value === 'object' && value !== null && '_zod' in value;
}

type JsonSchemaOf = (options: { target: string }) => Record<string, unknown>;

/** `~standard.jsonSchema.input` of a Standard JSON Schema, when the schema has one. */
function standardJsonSchema(value: unknown): JsonSchemaOf | undefined {
  const props = (value as { '~standard'?: { jsonSchema?: { input?: unknown } } } | null)?.['~standard'];
  const input = props?.jsonSchema?.input;
  return typeof input === 'function' ? (input.bind(props?.jsonSchema) as JsonSchemaOf) : undefined;
}

/**
 * JSON Schema (draft 7) for a zod 4 schema (`z.toJSONSchema`) or a Standard
 * JSON Schema, else `undefined`: zod 3 schemas keep the `ai` SDK's converter.
 */
export function schemaToJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (isZod4Schema(schema)) {
    return toJSONSchema(schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  }
  return standardJsonSchema(schema)?.({ target: 'draft-07' });
}

/**
 * The paths (`items[].due`) of each `z.date()` in a zod 4 schema, which
 * {@link schemaToJsonSchema} renders as `{}` (audit invoice F8). A
 * `z.coerce.date()` is not listed: it accepts the string a model writes.
 */
export function unrepresentableDates(schema: unknown): string[] {
  return isZod4Schema(schema) ? unrepresentableFields(schema).date : [];
}

/** The field kinds a model cannot write in JSON: a `Date` and a `bigint`. */
export interface UnrepresentableFields {
  date: string[];
  bigint: string[];
}

/**
 * The paths of each non-coercing `z.date()` and `z.bigint()` in a zod 3 or
 * zod 4 schema (Eve TOOLS-F10): a model writes a string or a number there,
 * which they reject. Fields under a zod 3 transform or preprocess are not
 * listed, since it may convert the value first.
 */
export function unrepresentableFields(schema: unknown): UnrepresentableFields {
  const found: UnrepresentableFields = { date: [], bigint: [] };
  if (isZod4Schema(schema)) {
    toJSONSchema(schema, {
      target: 'draft-7',
      io: 'input',
      unrepresentable: 'any',
      override: ({ zodSchema, path }) => {
        const def = zodSchema._zod.def as { type: string; coerce?: boolean };
        if ((def.type !== 'date' && def.type !== 'bigint') || def.coerce) return;
        found[def.type].push(jsonPathLabel(path));
      },
    });
  } else if (isZod3Schema(schema)) {
    walkZod3(schema as Zod3Node, '', found);
  }
  found.date.sort();
  found.bigint.sort();
  return found;
}

/** `items[].due` for a JSON Schema path such as `properties.items.items.properties.due`. */
function jsonPathLabel(path: ReadonlyArray<string | number>): string {
  let label = '';
  for (let i = 0; i < path.length; i++) {
    const part = path[i];
    if (part === 'properties' || part === 'additionalProperties') {
      if (part === 'additionalProperties') label += '[]';
      else if (i + 1 < path.length) label += (label ? '.' : '') + String(path[++i]);
    } else if (part === 'items' || part === 'prefixItems') {
      label += '[]';
    }
  }
  return label || '(root)';
}

interface Zod3Def {
  typeName?: string;
  coerce?: boolean;
  shape?: () => Record<string, Zod3Node>;
  type?: Zod3Node;
  innerType?: Zod3Node;
  options?: Zod3Node[] | Map<unknown, Zod3Node>;
  left?: Zod3Node;
  right?: Zod3Node;
  items?: Zod3Node[];
  rest?: Zod3Node | null;
  valueType?: Zod3Node;
  schema?: Zod3Node;
  in?: Zod3Node;
}
interface Zod3Node {
  _def: Zod3Def;
}

/** zod 3 kinds {@link walkZod3} reports (unless coerced). */
const ZOD3_LEAVES = new Map<string, keyof UnrepresentableFields>([
  ['ZodDate', 'date'],
  ['ZodBigInt', 'bigint'],
]);

/** A zod 3 child schema with its path label. */
type Zod3Child = readonly [Zod3Node | null | undefined, string];

/** The children of a zod 3 container, each with its path. */
type Zod3Children = (def: Zod3Def, path: string) => Zod3Child[];

/** The value schema of a set, record or map, as `path[]`. */
const zod3ValueChild: Zod3Children = (def, path) => [[def.valueType, `${path}[]`]];

/** The options of a union, at the union's own path. */
const zod3OptionChildren: Zod3Children = (def, path) =>
  [...(def.options instanceof Map ? def.options.values() : (def.options ?? []))].map((option) => [option, path] as const);

/** Per zod 3 container kind: the children {@link walkZod3} descends into (anything else: its `innerType`). */
const ZOD3_CHILDREN = new Map<string, Zod3Children>([
  ['ZodObject', (def, path) => Object.entries(def.shape?.() ?? {}).map(([key, child]) => [child, path ? `${path}.${key}` : key] as const)],
  ['ZodArray', (def, path) => [[def.type, `${path}[]`]]],
  ['ZodSet', zod3ValueChild],
  ['ZodRecord', zod3ValueChild],
  ['ZodMap', zod3ValueChild],
  ['ZodTuple', (def, path) => [...(def.items ?? []), def.rest].map((item) => [item, `${path}[]`] as const)],
  ['ZodUnion', zod3OptionChildren],
  ['ZodDiscriminatedUnion', zod3OptionChildren],
  [
    'ZodIntersection',
    (def, path) => [
      [def.left, path],
      [def.right, path],
    ],
  ],
  ['ZodBranded', (def, path) => [[def.type, path]]],
  ['ZodPipeline', (def, path) => [[def.in, path]]],
]);

/** Collects zod 3 `z.date()` / `z.bigint()` paths; does not descend into `ZodEffects` (a transform may convert). */
function walkZod3(node: Zod3Node | null | undefined, path: string, found: UnrepresentableFields, depth = 0): void {
  const def = node?._def;
  if (!def || depth > 64) return;
  const leaf = def.typeName === undefined ? undefined : ZOD3_LEAVES.get(def.typeName);
  if (leaf) {
    if (!def.coerce) found[leaf].push(path || '(root)');
    return;
  }
  const children = def.typeName === undefined ? undefined : ZOD3_CHILDREN.get(def.typeName);
  // ZodOptional, ZodNullable, ZodDefault, ZodCatch, ZodReadonly (and ZodEffects, which has no innerType).
  for (const [child, childPath] of children?.(def, path) ?? [[def.innerType, path] as const]) walkZod3(child, childPath, found, depth + 1);
}

/** zod 3 root kinds whose JSON Schema is not an object. */
const ZOD3_NON_OBJECT: Record<string, string> = {
  ZodString: 'string',
  ZodNumber: 'number',
  ZodBigInt: 'bigint',
  ZodBoolean: 'boolean',
  ZodDate: 'date',
  ZodArray: 'array',
  ZodTuple: 'array',
  ZodSet: 'array',
  ZodEnum: 'string',
  ZodNativeEnum: 'enum',
  ZodLiteral: 'literal',
  ZodNull: 'null',
};

/** The schema a zod 3 wrapper (optional, default, effects, brand, pipeline, ...) wraps, if any. */
function zod3Inner(def: Zod3Def): Zod3Node | undefined {
  if (def.innerType) return def.innerType;
  if (def.typeName === 'ZodEffects') return def.schema;
  if (def.typeName === 'ZodBranded') return def.type;
  if (def.typeName === 'ZodPipeline') return def.in;
  return undefined;
}

/**
 * The JSON type of a schema's root when it is plainly not an object
 * (`'string'`, `'array'`, ...), else `undefined` (an object, a union of
 * objects, or a root that cannot be told). Tool arguments are a JSON object,
 * and providers reject a tool whose parameters are not (Eve TOOLS-F10).
 */
export function nonObjectRoot(schema: unknown): string | undefined {
  if (isZod3Schema(schema)) {
    let def = (schema as Zod3Node)._def;
    for (let depth = 0; depth < 16; depth++) {
      const inner = zod3Inner(def);
      if (!inner?._def) break;
      def = inner._def;
    }
    return ZOD3_NON_OBJECT[def.typeName ?? ''];
  }
  let json: Record<string, unknown> | undefined;
  try {
    json = schemaToJsonSchema(schema);
  } catch {
    return undefined;
  }
  const type = json?.type;
  if (typeof type === 'string' && type !== 'object') return type;
  if (Array.isArray(type) && !type.includes('object')) return type.join(' | ');
  return undefined;
}

/** Whether a schema can be sent to a model: zod 3, zod 4, or a Standard JSON Schema. */
export function isModelSchema(value: unknown): boolean {
  return isZod3Schema(value) || isZod4Schema(value) || standardJsonSchema(value) !== undefined;
}

/**
 * A plain JSON-Schema object (LOU-R4): an object that is none of the schema
 * forms {@link isModelSchema} recognizes and not an 'ai' `jsonSchema()`
 * wrapper either (`{jsonSchema, validate}`). `defineTool({ input })` accepts
 * raw JSON Schemas; 'ai' v4 would run one through its zod converter and crash
 * reading `._def.typeName`, so callers wrap it with `ai.jsonSchema()` - which
 * ai 6/7's conversion already does for every non-Standard-Schema object.
 */
export function isRawJsonSchema(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return !isModelSchema(value) && !('jsonSchema' in value) && !('~standard' in value);
}

/**
 * An issue's message, worded the same on both majors: zod 4's default
 * `Invalid input: expected string, received undefined` reads as zod 3's
 * `Required`, and other type mismatches as `Expected number, received string`.
 */
export function issueMessage(issue: { message: string }): string {
  const mismatch = /^Invalid input: expected (.+), received (.+)$/.exec(issue.message);
  if (!mismatch) return issue.message;
  return mismatch[2] === 'undefined' ? 'Required' : `Expected ${mismatch[1]}, received ${mismatch[2]}`;
}

/** An issue's path joined with dots, `(root)` when empty. */
export function issuePath(issue: SchemaIssue): string {
  const path = (issue.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment));
  return path.length > 0 ? path.join('.') : '(root)';
}

/** Whether the installed `zod` is zod 4. */
const ZOD4 = isZod4Schema(z.string());

/** Error customization both majors' types accept; the value is the installed major's own form. */
type ErrorParams = { message?: string };

/** Messages for a missing value and a wrong-typed one, e.g. `z.string(typeErrors({ required: '...' }))`. */
export function typeErrors(messages: { required?: string; invalid?: string }): ErrorParams {
  if (!ZOD4) return { required_error: messages.required, invalid_type_error: messages.invalid } as ErrorParams;
  return { error: (issue: { input?: unknown }) => (issue.input === undefined ? messages.required : messages.invalid) } as ErrorParams;
}

/**
 * One message for every issue the schema itself raises (a union that matched
 * no option, a value not in an enum), optionally worded from the input.
 */
export function anyError(message: string | ((input: unknown) => string)): ErrorParams {
  const text = typeof message === 'string' ? () => message : message;
  if (ZOD4) return { error: (issue: { input?: unknown }) => text(issue.input) } as ErrorParams;
  return { errorMap: (_issue: unknown, ctx: { data?: unknown }) => ({ message: text(ctx.data) }) } as ErrorParams;
}
