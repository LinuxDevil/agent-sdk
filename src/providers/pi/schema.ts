/**
 * Lousho tool `parameters` -> the JSON Schema pi's `Tool.parameters` takes.
 *
 * The schema is converted once per tool and cached on the schema object
 * itself (WeakMap), because AgentExecutor sends the same `ToolDefinition[]`
 * every step of a run.
 *
 * Coverage, mirroring `v4Parameters()` in aiSdkProvider.ts:
 * - zod 4 and Standard-JSON-Schema inputs go through `schemaToJsonSchema()`
 *   (draft-7 output), plain JSON-Schema objects pass through, and an `ai`
 *   `jsonSchema()` wrapper unwraps to its `.jsonSchema`.
 * - zod 3 (`_def.typeName`) has no converter of its own in this package's
 *   dependency set, so {@link zod3ToJsonSchema} maps the common node kinds
 *   by hand. Anything unrecognized becomes `true` (a schema that accepts
 *   everything) rather than a thrown error - a permissive parameter schema
 *   is a prompt-fidelity loss, not a crash; pi and the wire APIs accept it.
 */

import { isRawJsonSchema, isZod4Schema, schemaToJsonSchema } from '../../utils/zodCompat';

/** zod3 `_def`, the parts the converter reads. */
interface Zod3Def {
  typeName?: string;
  description?: string;
  shape?: () => Record<string, unknown>;
  type?: unknown;
  innerType?: unknown;
  valueType?: unknown;
  keyType?: unknown;
  items?: unknown[];
  options?: unknown[];
  value?: unknown;
  values?: unknown[];
  schema?: unknown;
  checks?: Array<{ kind?: string; value?: unknown; regex?: unknown; inclusive?: boolean; format?: string }>;
  errorMap?: unknown;
  catchValue?: unknown;
  getter?: unknown;
  left?: unknown;
  right?: unknown;
}

const defOf = (schema: unknown): Zod3Def => (schema as { _def?: Zod3Def } | null)?._def ?? {};

/** Check kinds that map straight onto a JSON Schema `format` string. */
const FORMAT_KINDS = new Set([
  'email', 'url', 'uuid', 'datetime', 'date', 'time', 'ipv4', 'ipv6', 'emoji',
  'nanoid', 'cuid', 'cuid2', 'ulid', 'base64', 'jwt', 'ip',
]);

type Zod3Check = NonNullable<Zod3Def['checks']>[number];

const BOUND_KEYS = {
  min: { string: 'minLength', array: 'minItems', number: 'minimum', exclusive: 'exclusiveMinimum' },
  max: { string: 'maxLength', array: 'maxItems', number: 'maximum', exclusive: 'exclusiveMaximum' },
} as const;

/** A `min`/`max` check applied to the string, number, or array keyword it bounds. */
function applyBound(json: Record<string, unknown>, kind: 'min' | 'max', check: Zod3Check): void {
  const keys = BOUND_KEYS[kind];
  if (json.type === 'string') json[keys.string] = check.value;
  else if (json.type === 'array') json[keys.array] = check.value;
  else if (json.type === 'number' || json.type === 'integer') json[check.inclusive === false ? keys.exclusive : keys.number] = check.value;
}

/** Number/string/array `checks` of a zod 3 schema, applied to its JSON Schema. */
function applyChecks(json: Record<string, unknown>, checks: Zod3Def['checks']): void {
  for (const check of checks ?? []) {
    const kind = check.kind ?? '';
    if (kind === 'min' || kind === 'max') applyBound(json, kind, check);
    else if (kind === 'int' && json.type === 'number') json.type = 'integer';
    else if (kind === 'regex' && check.regex instanceof RegExp) json.pattern = check.regex.source;
    else if (kind === 'multiple_of') json.multipleOf = check.value;
    else if (FORMAT_KINDS.has(kind)) json.format = kind;
    // 'finite' has no JSON Schema marker; `type: number` already implies it to a model.
  }
}

function withDescription(json: Record<string, unknown>, def: Zod3Def): Record<string, unknown> {
  if (typeof def.description === 'string' && def.description) json.description = def.description;
  return json;
}

const ANY: Record<string, unknown> = {};

type Zod3Json = Record<string, unknown>;
type Zod3Converter = (def: Zod3Def) => Zod3Json | undefined;

/** `type` + the node's `checks` applied, carrying the node's `description`. */
function checked(type: string, def: Zod3Def): Zod3Json {
  const json: Zod3Json = { type };
  applyChecks(json, def.checks);
  return withDescription(json, def);
}

/**
 * Wrapper kinds (`optional`/`default`/`catch`/...): the input schema the model
 * sees is the wrapped type. `nullable` is expressed as an anyOf so a
 * `z.string().nullable()` still validates null.
 */
function wrappedType(def: Zod3Def): Zod3Json | undefined {
  const inner = zod3ToJsonSchema(def.innerType);
  if (def.typeName === 'ZodNullable' && inner && inner.type !== undefined) {
    const { description: _d, ...rest } = inner;
    return withDescription({ anyOf: [rest, { type: 'null' }] }, def);
  }
  return inner ? withDescription({ ...inner }, def) : undefined;
}

function objectType(def: Zod3Def): Zod3Json {
  const shape = def.shape?.() ?? {};
  const properties: Zod3Json = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    properties[key] = zod3ToJsonSchema(value) ?? { ...ANY };
    // A zod 3 field is required unless it is optional/defaulted: detect
    // that through the same `_def.typeName` walk callers do.
    if (isRequired(value)) required.push(key);
  }
  return withDescription({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }, def);
}

function mapOptions(def: Zod3Def, key: 'options' | 'items'): Zod3Json[] {
  return ((def[key] ?? []) as unknown[]).map((item) => zod3ToJsonSchema(item) ?? { ...ANY });
}

/** Laziness/cycles and non-serializable inputs have no JSON Schema; the model gets the empty schema and the executor still validates locally. */
const emptySchema = (): Zod3Json => ({ ...ANY });

const ZOD3_CONVERTERS: Record<string, Zod3Converter> = {
  ZodString: (def) => checked('string', def),
  ZodNumber: (def) => checked('number', def),
  ZodBigInt: (def) => withDescription({ type: 'integer' }, def),
  ZodBoolean: (def) => withDescription({ type: 'boolean' }, def),
  ZodDate: (def) => withDescription({ type: 'string', format: 'date-time' }, def),
  ZodEnum: (def) => withDescription({ type: 'string', enum: [...(def.values ?? [])] }, def),
  ZodNativeEnum: (def) => withDescription({ enum: Object.values(def.values ?? {}) }, def),
  ZodLiteral: (def) => withDescription({ const: def.value, enum: [def.value] }, def),
  ZodNull: () => ({ type: 'null' }),
  ZodUndefined: () => ({ not: {} }),
  ZodVoid: () => ({ not: {} }),
  ZodNever: () => ({ not: {} }),
  ZodAny: emptySchema,
  ZodUnknown: emptySchema,
  ZodOptional: wrappedType,
  ZodNullable: wrappedType,
  ZodDefault: wrappedType,
  ZodReadonly: wrappedType,
  ZodBranded: wrappedType,
  ZodCatch: wrappedType,
  // Refinements/transforms change nothing about what the model may send.
  ZodEffects: (def) => zod3ToJsonSchema(def.schema ?? def.innerType),
  ZodArray: (def) => {
    const items = zod3ToJsonSchema(def.type);
    const json: Zod3Json = { type: 'array', ...(items ? { items } : {}) };
    applyChecks(json, def.checks);
    return withDescription(json, def);
  },
  ZodObject: objectType,
  ZodRecord: (def) => {
    const values = zod3ToJsonSchema(def.valueType);
    return withDescription({ type: 'object', ...(values ? { additionalProperties: values } : { additionalProperties: true }) }, def);
  },
  ZodTuple: (def) => {
    const items = mapOptions(def, 'items');
    return withDescription({ type: 'array', prefixItems: items, minItems: items.length, maxItems: items.length }, def);
  },
  ZodUnion: (def) => withDescription({ anyOf: mapOptions(def, 'options') }, def),
  ZodDiscriminatedUnion: (def) => withDescription({ anyOf: mapOptions(def, 'options') }, def),
  ZodIntersection: (def) => {
    const allOf = [zod3ToJsonSchema(def.left), zod3ToJsonSchema(def.right)].filter(Boolean) as Zod3Json[];
    return withDescription({ allOf }, def);
  },
  ZodSet: (def) => {
    const items = zod3ToJsonSchema(def.valueType);
    return withDescription({ type: 'array', uniqueItems: true, ...(items ? { items } : {}) }, def);
  },
};

/**
 * Recursive zod 3 -> JSON Schema for the node kinds a tool's `input` schema
 * realistically uses. `unrepresentable` nodes (`ZodEffects` transforms and
 * refinements included) collapse to their input schema or to `true`, the
 * same fallback zod 4's `unrepresentable: 'any'` applies.
 */
function zod3ToJsonSchema(schema: unknown): Zod3Json | undefined {
  const def = defOf(schema);
  return (ZOD3_CONVERTERS[def.typeName ?? ''] ?? emptySchema)(def);
}

/** Whether a zod 3 field must be sent (not `.optional()`/`.default()`/`catch()`-wrapped). */
function isRequired(schema: unknown): boolean {
  let def = defOf(schema);
  let guard = 0;
  while (guard++ < 10) {
    switch (def.typeName) {
      case 'ZodOptional':
      case 'ZodDefault':
      case 'ZodCatch':
        return false;
      case 'ZodNullable':
      case 'ZodReadonly':
      case 'ZodBranded':
      case 'ZodEffects': {
        const inner = def.innerType ?? def.schema;
        if (inner === undefined) return true;
        def = defOf(inner);
        break;
      }
      default:
        return true;
    }
  }
  return true;
}

/** An `ai` `jsonSchema()` wrapper: `{ jsonSchema: {...}, validate }`. */
function jsonSchemaWrapper(value: unknown): Record<string, unknown> | undefined {
  const boxed = (value as { jsonSchema?: unknown } | null)?.jsonSchema;
  return typeof boxed === 'object' && boxed !== null ? (boxed as Record<string, unknown>) : undefined;
}

const cache = new WeakMap<object, Record<string, unknown>>();

/**
 * JSON Schema for a `ToolDefinition.function.parameters`, converted once and
 * cached. Returns `undefined` only for `undefined`/`null` input - callers
 * then send `{ type: 'object' }`.
 */
export function toolParametersToJsonSchema(parameters: unknown): Record<string, unknown> | undefined {
  if (parameters === undefined || parameters === null) return undefined;
  if (typeof parameters !== 'object') return undefined;

  const cached = cache.get(parameters);
  if (cached) return cached;

  const json =
    schemaToJsonSchema(parameters) ??
    (isRawJsonSchema(parameters) ? parameters : jsonSchemaWrapper(parameters) ?? (!isZod4Schema(parameters) ? zod3ToJsonSchema(parameters) : undefined)) ??
    { ...ANY };
  cache.set(parameters, json);
  return json;
}
