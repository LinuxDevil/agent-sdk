export type JsonSchema = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function schemaParts(schema: JsonSchema): JsonSchema[] {
  const allOf = Array.isArray(schema.allOf) ? schema.allOf.filter(isRecord) : [];
  return [schema, ...allOf.flatMap(schemaParts)];
}

function propertyOf(schema: JsonSchema, name: string): JsonSchema | undefined {
  for (const part of schemaParts(schema)) {
    const properties = part.properties;
    if (isRecord(properties) && Object.hasOwn(properties, name) && isRecord(properties[name])) return properties[name];
  }
  return undefined;
}

export function fieldSchema(root: JsonSchema | undefined, bind: string): JsonSchema | undefined {
  return inputPath(bind).reduce<JsonSchema | undefined>((schema, name) => (schema === undefined ? undefined : propertyOf(schema, name)), root);
}

function inputPath(bind: string): string[] {
  return bind.split('.').slice(1);
}

export function enumValues(schema: JsonSchema | undefined): unknown[] {
  if (schema === undefined) return [];
  return schemaParts(schema).flatMap((part) => [...(Array.isArray(part.enum) ? part.enum : []), ...('const' in part ? [part.const] : [])]);
}
