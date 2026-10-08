/**
 * JSON Schema -> Zod conversion utility (LOU-F1, LOU-Z1)
 *
 * Converts the plain-JSON-Schema `inputSchema` objects that MCP tools
 * advertise into Zod schemas so the SDK can validate a model's tool
 * arguments before calling the remote server.
 *
 * Since arguments are validated with the converted schema, a too-strict
 * conversion would reject calls the server accepts. The converter is
 * therefore permissive wherever JSON Schema is ambiguous or a keyword has no
 * zod equivalent: it falls back to `z.any()` and never throws on an
 * unrecognised keyword, type or shape.
 */

import { z, ZodTypeAny } from 'zod';

type JsonSchema = Record<string, unknown>;

/** Resolution state shared by one conversion run. */
interface Context {
  /** The document root, used to resolve local `$ref` pointers. */
  root: unknown;
  /** `$ref` pointers currently being expanded (cycle protection). */
  active: ReadonlySet<string>;
  depth: number;
}

/** Nesting deeper than this falls back to `z.any()` (guards pathological input). */
const MAX_DEPTH = 64;

/**
 * Convert a JSON Schema object into an equivalent Zod schema.
 *
 * Supported: `type` (string or array of types, including `null`), `enum`
 * (mixed types), `const`, `anyOf` / `oneOf` (union; `[X, {type:'null'}]`
 * becomes `X.nullable()`; next to an object's own `type` / `properties` the
 * branches are ignored and the object is kept), `allOf` (merge / intersection), local `$ref` into
 * `$defs` / `definitions` (a recursive ref falls back to `z.any()` for the
 * inner occurrence), `properties` / `required`, `additionalProperties`
 * (boolean or schema), `items`, `default`, `description`, and the
 * constraints `minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum`,
 * `minLength` / `maxLength` / `pattern` and `minItems` / `maxItems`. An
 * invalid `pattern` regex is skipped.
 *
 * Anything else (unknown keywords, empty or boolean schemas, unresolvable
 * refs) becomes permissive `z.any()` - this function does not throw for
 * schema content.
 *
 * `root` is the document that local `$ref` pointers (`#/components/schemas/Pet`)
 * resolve against; it defaults to `schema` itself. `openApiTools()` passes the
 * whole OpenAPI document.
 *
 * @example
 * const schema = jsonSchemaToZod({
 *   type: 'object',
 *   properties: { labels: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] } },
 * });
 * schema.parse({ labels: null }); // ok
 */
export function jsonSchemaToZod(schema: unknown, root: unknown = schema): ZodTypeAny {
  return convert(schema, { root, active: new Set(), depth: 0 });
}

function isRecord(value: unknown): value is JsonSchema {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function convert(schema: unknown, ctx: Context): ZodTypeAny {
  if (!isRecord(schema) || ctx.depth > MAX_DEPTH) return z.any();
  const next: Context = { ...ctx, depth: ctx.depth + 1 };
  return applyDescription(convertKeywords(schema, next), schema);
}

function convertKeywords(schema: JsonSchema, ctx: Context): ZodTypeAny {
  if (typeof schema.$ref === 'string') return convertRef(schema.$ref, ctx);
  if ('const' in schema) return convertConst(schema.const);
  if (Array.isArray(schema.enum)) return convertEnum(schema.enum);
  if (Array.isArray(schema.allOf)) return convertAllOf(schema, ctx);
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) {
    if (isObjectBase(schema)) return convertObjectWithSiblingUnion(schema, ctx);
    return convertUnion(variants, ctx);
  }
  return withDefault(convertTyped(schema, ctx), schema);
}

/** `type: 'object'` or `properties` next to the keyword: the schema is an object. */
function isObjectBase(schema: JsonSchema): boolean {
  return schema.type === 'object' || isRecord(schema.properties);
}

/**
 * An object schema with a sibling `anyOf` / `oneOf` (often required-only
 * branches like `oneOf: [{ required: ['id'] }, { required: ['title'] }]`)
 * keeps its object shape; the branches are left to the server to enforce.
 * Converting them to a union would turn the root into `anyOf: [{}, {}]`,
 * which providers reject (Eve TOOLS-F4).
 */
function convertObjectWithSiblingUnion(schema: JsonSchema, ctx: Context): ZodTypeAny {
  const { anyOf: _anyOf, oneOf: _oneOf, ...base } = schema;
  return withDefault(convertTyped(base, ctx), base);
}

function applyDescription(zodType: ZodTypeAny, schema: JsonSchema): ZodTypeAny {
  if (typeof schema.description === 'string' && schema.description.length > 0) {
    return zodType.describe(schema.description);
  }
  return zodType;
}

function withDefault(zodType: ZodTypeAny, schema: JsonSchema): ZodTypeAny {
  return 'default' in schema && schema.default !== undefined
    ? zodType.default(schema.default)
    : zodType;
}

// --- $ref ------------------------------------------------------------------

/** Resolve a local JSON pointer (`#/$defs/Foo`) against the document root. */
function resolvePointer(root: unknown, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    let segment = raw;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      // keep the raw segment
    }
    segment = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isRecord(node) && !Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

function convertRef(ref: string, ctx: Context): ZodTypeAny {
  if (ctx.active.has(ref)) return z.any();
  const target = resolvePointer(ctx.root, ref);
  if (target === undefined) return z.any();
  return convert(target, { ...ctx, active: new Set(ctx.active).add(ref) });
}

// --- const / enum ----------------------------------------------------------

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function convertConst(value: unknown): ZodTypeAny {
  return isPrimitive(value) ? z.literal(value) : z.any();
}

function convertEnum(values: unknown[]): ZodTypeAny {
  if (values.length === 0 || !values.every(isPrimitive)) return z.any();
  if (values.every((v) => typeof v === 'string')) {
    return z.enum(values as [string, ...string[]]);
  }
  return unionOf(values.map((v) => z.literal(v as string | number | boolean | null)));
}

// --- unions / allOf --------------------------------------------------------

function unionOf(members: ZodTypeAny[]): ZodTypeAny {
  if (members.length === 0) return z.any();
  if (members.length === 1) return members[0];
  return z.union(members as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
}

function isNullSchema(schema: unknown): boolean {
  return isRecord(schema) && schema.type === 'null' && Object.keys(schema).every(
    (key) => key === 'type' || key === 'description'
  );
}

function convertUnion(variants: unknown[], ctx: Context): ZodTypeAny {
  const nullable = variants.some(isNullSchema);
  const rest = variants.filter((variant) => !isNullSchema(variant));
  const union = unionOf(rest.map((variant) => convert(variant, ctx)));
  if (!nullable) return union;
  return rest.length === 0 ? z.null() : union.nullable();
}

function mergeTwo(a: ZodTypeAny, b: ZodTypeAny): ZodTypeAny {
  if (a instanceof z.ZodObject && b instanceof z.ZodObject) return a.merge(b);
  return z.intersection(a, b);
}

function convertAllOf(schema: JsonSchema, ctx: Context): ZodTypeAny {
  const { allOf, ...own } = schema;
  const parts = (allOf as unknown[]).map((part) => convert(part, ctx));
  if (Object.keys(own).some((key) => key !== 'description')) {
    parts.unshift(convert(own, ctx));
  }
  return parts.length === 0 ? z.any() : parts.reduce(mergeTwo);
}

// --- typed schemas ---------------------------------------------------------

function convertTyped(schema: JsonSchema, ctx: Context): ZodTypeAny {
  if (Array.isArray(schema.type)) return convertTypeArray(schema, schema.type, ctx);
  return convertSingleType(schema, schema.type, ctx);
}

function convertTypeArray(schema: JsonSchema, types: unknown[], ctx: Context): ZodTypeAny {
  const nullable = types.includes('null');
  const members = types
    .filter((type) => type !== 'null')
    .map((type) => convertSingleType(schema, type, ctx));
  const union = unionOf(members);
  if (!nullable) return union;
  return members.length === 0 ? z.null() : union.nullable();
}

function convertSingleType(schema: JsonSchema, type: unknown, ctx: Context): ZodTypeAny {
  switch (type) {
    case 'object':
      return convertObject(schema, ctx);
    case 'array':
      return convertArray(schema, ctx);
    case 'string':
      return convertString(schema);
    case 'number':
      return convertNumber(schema, false);
    case 'integer':
      return convertNumber(schema, true);
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    default:
      return inferFromKeywords(schema, ctx);
  }
}

/** No (or an unknown) `type`: infer from structural keywords, else `z.any()`. */
function inferFromKeywords(schema: JsonSchema, ctx: Context): ZodTypeAny {
  if (isRecord(schema.properties)) return convertObject(schema, ctx);
  if (schema.items !== undefined) return convertArray(schema, ctx);
  return z.any();
}

function convertObject(schema: JsonSchema, ctx: Context): ZodTypeAny {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    const propZod = convert(propSchema, ctx);
    // A ZodDefault already accepts `undefined`; wrapping it in optional() would skip the default.
    const keepAsIs = required.includes(key) || propZod instanceof z.ZodDefault;
    shape[key] = keepAsIs ? propZod : propZod.optional();
  }
  return applyAdditionalProperties(z.object(shape), schema.additionalProperties, ctx);
}

/**
 * JSON Schema allows extra properties unless `additionalProperties` says
 * otherwise, so unknown keys pass through by default instead of being
 * stripped from the arguments the server receives.
 */
function applyAdditionalProperties(
  object: z.ZodObject<Record<string, ZodTypeAny>>,
  additional: unknown,
  ctx: Context
): ZodTypeAny {
  if (additional === false) return object.strict();
  if (isRecord(additional)) return object.catchall(convert(additional, ctx));
  return object.passthrough();
}

function convertArray(schema: JsonSchema, ctx: Context): ZodTypeAny {
  // Tuple-form `items` (an array) is ambiguous across drafts: stay permissive.
  const item = isRecord(schema.items) ? convert(schema.items, ctx) : z.any();
  let array = z.array(item);
  if (typeof schema.minItems === 'number') array = array.min(schema.minItems);
  if (typeof schema.maxItems === 'number') array = array.max(schema.maxItems);
  return array;
}

function convertString(schema: JsonSchema): ZodTypeAny {
  let str = z.string();
  if (typeof schema.minLength === 'number') str = str.min(schema.minLength);
  if (typeof schema.maxLength === 'number') str = str.max(schema.maxLength);
  const pattern = compilePattern(schema.pattern);
  return pattern ? str.regex(pattern) : str;
}

/** Compile a `pattern`; an invalid regex is skipped rather than thrown. */
function compilePattern(pattern: unknown): RegExp | undefined {
  if (typeof pattern !== 'string') return undefined;
  try {
    return new RegExp(pattern, 'u');
  } catch {
    try {
      return new RegExp(pattern);
    } catch {
      return undefined;
    }
  }
}

function convertNumber(schema: JsonSchema, integer: boolean): ZodTypeAny {
  let num = z.number();
  if (integer) num = num.int();
  if (typeof schema.minimum === 'number') num = num.min(schema.minimum);
  if (typeof schema.maximum === 'number') num = num.max(schema.maximum);
  // Draft-6+ numeric form only; the draft-4 boolean form is ignored (permissive).
  if (typeof schema.exclusiveMinimum === 'number') num = num.gt(schema.exclusiveMinimum);
  if (typeof schema.exclusiveMaximum === 'number') num = num.lt(schema.exclusiveMaximum);
  return num;
}
