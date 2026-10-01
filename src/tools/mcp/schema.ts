/**
 * JSON Schema -> Zod conversion utility (LOU-F1)
 *
 * Converts the plain-JSON-Schema `inputSchema` objects that MCP tools
 * advertise into Zod schemas so they can be plugged straight into the
 * 'ai' SDK's `tool({ parameters })` (which expects a ZodTypeAny).
 *
 * Deliberately NOT supported in this ticket: `$ref` / recursive schemas.
 * MCP tool schemas are typically flat, and properly resolving `$ref`
 * (including cycles, which Zod can only express via z.lazy()) is a
 * meaningfully bigger problem than the rest of this converter. Rather
 * than silently produce a wrong/partial schema, we throw a clear error
 * so callers know the schema needs manual handling.
 */

import { z, ZodTypeAny } from 'zod';

/**
 * Convert a JSON Schema object into an equivalent Zod schema.
 *
 * Supported keywords: `type` (object/array/string/number/integer/boolean),
 * `enum`, `properties`/`required` (object), `items` (array), `description`.
 *
 * Throws for `$ref` (anywhere in the schema, since it signals either a
 * genuine cross-reference or a recursive/self-referential schema, neither
 * of which this converter attempts to resolve) and for any other
 * unsupported/unrecognized schema shape.
 */
export function jsonSchemaToZod(schema: any): ZodTypeAny {
  return convert(schema);
}

/**
 * Builders for each supported JSON Schema `type`. A Map (not an object
 * literal) so that a `type` like 'toString' can't resolve to an inherited
 * Object.prototype member.
 */
const TYPE_CONVERTERS = new Map<string, typeof convertObject>([
  ['object', (schema) => convertObject(schema)],
  ['array', (schema) => convertArray(schema)],
  ['string', () => z.string()],
  ['number', () => z.number()],
  ['integer', () => z.number().int()],
  ['boolean', () => z.boolean()],
]);

function convert(schema: any): ZodTypeAny {
  assertConvertible(schema);

  // enum takes precedence over `type`, since a schema may specify both.
  if (Array.isArray(schema.enum)) {
    return applyDescription(convertEnum(schema.enum), schema);
  }

  const converter = TYPE_CONVERTERS.get(schema.type);
  if (!converter) {
    throw new Error(
      `jsonSchemaToZod: unsupported schema type '${schema.type}' in ${JSON.stringify(schema)}`
    );
  }
  return applyDescription(converter(schema), schema);
}

/** Reject non-objects and `$ref` schemas up front. */
function assertConvertible(schema: unknown): void {
  if (schema === null || typeof schema !== 'object') {
    throw new Error(
      `jsonSchemaToZod: expected a JSON Schema object, got ${JSON.stringify(schema)}`
    );
  }

  if ('$ref' in schema) {
    throw new Error(
      'jsonSchemaToZod: $ref (and recursive schemas) are not supported in this converter'
    );
  }
}

function applyDescription(zodType: ZodTypeAny, schema: any): ZodTypeAny {
  if (typeof schema.description === 'string' && schema.description.length > 0) {
    return zodType.describe(schema.description);
  }
  return zodType;
}

function convertEnum(values: unknown[]): ZodTypeAny {
  if (values.length === 0) {
    throw new Error('jsonSchemaToZod: enum must have at least one value');
  }
  if (values.every((v) => typeof v === 'string')) {
    return z.enum(values as [string, ...string[]]);
  }
  // Non-string enums (numbers, booleans, mixed) fall back to a union of
  // literals, which Zod's z.enum() cannot express directly.
  const literals = values.map((v) => z.literal(v as any));
  if (literals.length === 1) {
    return literals[0];
  }
  return z.union(literals as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
}

function convertObject(schema: any): ZodTypeAny {
  const properties = schema.properties ?? {};
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];

  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    let propZod = convert(propSchema);
    if (!required.includes(key)) {
      propZod = propZod.optional();
    }
    shape[key] = propZod;
  }

  return z.object(shape);
}

function convertArray(schema: any): ZodTypeAny {
  if (schema.items === undefined) {
    throw new Error('jsonSchemaToZod: array schema is missing "items"');
  }
  const itemZod = convert(schema.items);
  return z.array(itemZod);
}
