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

/** Number/string/array `checks` of a zod 3 schema, applied to its JSON Schema. */
function applyChecks(json: Record<string, unknown>, checks: Zod3Def['checks']): void {
  for (const check of checks ?? []) {
    switch (check.kind) {
      case 'min':
        if (json.type === 'string') json.minLength = check.value;
        else if (json.type === 'number' || json.type === 'integer') json[check.inclusive === false ? 'exclusiveMinimum' : 'minimum'] = check.value;
        else if (json.type === 'array') json.minItems = check.value;
        break;
      case 'max':
        if (json.type === 'string') json.maxLength = check.value;
        else if (json.type === 'number' || json.type === 'integer') json[check.inclusive === false ? 'exclusiveMaximum' : 'maximum'] = check.value;
        else if (json.type === 'array') json.maxItems = check.value;
        break;
      case 'int':
        if (json.type === 'number') json.type = 'integer';
        break;
      case 'regex':
        if (check.regex instanceof RegExp) json.pattern = check.regex.source;
        break;
      case 'email':
      case 'url':
      case 'uuid':
      case 'datetime':
      case 'date':
      case 'time':
      case 'ipv4':
      case 'ipv6':
      case 'emoji':
      case 'nanoid':
      case 'cuid':
      case 'cuid2':
      case 'ulid':
      case 'base64':
      case 'jwt':
      case 'ip':
        json.format = check.kind === 'ip' ? 'ip' : check.kind;
        break;
      case 'multiple_of':
        json.multipleOf = check.value;
        break;
      case 'finite':
        break; // JSON Schema has no finite marker; `type: number` already implies it to a model.
      default:
        break;
    }
  }
}

function withDescription(json: Record<string, unknown>, def: Zod3Def): Record<string, unknown> {
  if (typeof def.description === 'string' && def.description) json.description = def.description;
  return json;
}

const ANY: Record<string, unknown> = {};

/**
 * Recursive zod 3 -> JSON Schema for the node kinds a tool's `input` schema
 * realistically uses. `unrepresentable` nodes (`ZodEffects` transforms and
 * refinements included) collapse to their input schema or to `true`, the
 * same fallback zod 4's `unrepresentable: 'any'` applies.
 */
function zod3ToJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  const def = defOf(schema);
  switch (def.typeName) {
    case 'ZodString': {
      const json: Record<string, unknown> = { type: 'string' };
      applyChecks(json, def.checks);
      return withDescription(json, def);
    }
    case 'ZodNumber': {
      const json: Record<string, unknown> = { type: 'number' };
      applyChecks(json, def.checks);
      return withDescription(json, def);
    }
    case 'ZodBigInt':
      return withDescription({ type: 'integer' }, def);
    case 'ZodBoolean':
      return withDescription({ type: 'boolean' }, def);
    case 'ZodDate':
      return withDescription({ type: 'string', format: 'date-time' }, def);
    case 'ZodEnum':
      return withDescription({ type: 'string', enum: [...(def.values ?? [])] }, def);
    case 'ZodNativeEnum':
      return withDescription({ enum: Object.values(def.values ?? {}) }, def);
    case 'ZodLiteral':
      return withDescription({ const: def.value, enum: [def.value] }, def);
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodUndefined':
    case 'ZodVoid':
    case 'ZodNever':
      return { not: {} };
    case 'ZodAny':
    case 'ZodUnknown':
      return { ...ANY };
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodReadonly':
    case 'ZodBranded':
    case 'ZodCatch': {
      // The input schema the model sees is the wrapped type; `nullable` is
      // expressed as an anyOf so a `z.string().nullable()` still validates null.
      const inner = zod3ToJsonSchema(def.innerType);
      if (def.typeName === 'ZodNullable' && inner && inner.type !== undefined) {
        const { description: _d, ...rest } = inner;
        return withDescription({ anyOf: [rest, { type: 'null' }] }, def);
      }
      return inner ? withDescription({ ...inner }, def) : undefined;
    }
    case 'ZodEffects':
      // Refinements/transforms change nothing about what the model may send.
      return zod3ToJsonSchema(def.schema ?? def.innerType);
    case 'ZodArray': {
      const items = zod3ToJsonSchema(def.type);
      const json: Record<string, unknown> = { type: 'array', ...(items ? { items } : {}) };
      applyChecks(json, def.checks);
      return withDescription(json, def);
    }
    case 'ZodObject': {
      const shape = def.shape?.() ?? {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const property = zod3ToJsonSchema(value) ?? { ...ANY };
        properties[key] = property;
        // A zod 3 field is required unless it is optional/defaulted: detect
        // that through the same `_def.typeName` walk callers do.
        if (isRequired(value)) required.push(key);
      }
      return withDescription({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }, def);
    }
    case 'ZodRecord': {
      const values = zod3ToJsonSchema(def.valueType);
      return withDescription({ type: 'object', ...(values ? { additionalProperties: values } : { additionalProperties: true }) }, def);
    }
    case 'ZodTuple': {
      const items = (def.items ?? []).map((item) => zod3ToJsonSchema(item) ?? { ...ANY });
      return withDescription({ type: 'array', prefixItems: items, minItems: items.length, maxItems: items.length }, def);
    }
    case 'ZodUnion': {
      const options = (def.options ?? []).map((option) => zod3ToJsonSchema(option) ?? { ...ANY });
      return withDescription({ anyOf: options }, def);
    }
    case 'ZodDiscriminatedUnion': {
      const options = (def.options ?? []).map((option) => zod3ToJsonSchema(option) ?? { ...ANY });
      return withDescription({ anyOf: options }, def);
    }
    case 'ZodIntersection': {
      const allOf = [zod3ToJsonSchema(def.left), zod3ToJsonSchema(def.right)].filter(Boolean) as Record<string, unknown>[];
      return withDescription({ allOf }, def);
    }
    case 'ZodSet': {
      const items = zod3ToJsonSchema(def.valueType);
      return withDescription({ type: 'array', uniqueItems: true, ...(items ? { items } : {}) }, def);
    }
    case 'ZodMap':
    case 'ZodPromise':
    case 'ZodLazy':
    case 'ZodFunction':
    case 'ZodNaN':
    case 'ZodSymbol':
    default:
      // Laziness/cycles and non-serializable inputs have no JSON Schema; the
      // model gets the empty schema and the executor still validates locally.
      return { ...ANY };
  }
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
