/**
 * Structured output (LOU-V4): what a run with `ExecuteOptions.output` adds
 * to the request (an instruction in the system prompt and a
 * `responseFormat` hint), and the parse/validate/repair of its final reply.
 */

import { zodSchema } from 'ai';
import type { GenerateOptions, Message } from '../providers';
import { formatIssues, parseWithIssues, type ToolArgumentIssue } from './toolArgsValidation';
import { schemaToJsonSchema, type StandardSchemaV1 } from '../utils/zodCompat';

/** Why a run's final reply is not a valid `output` object (`finishReason: 'output-invalid'`). */
export interface OutputError {
  /** Model-readable summary, e.g. `The reply does not match the output schema: 1 issue (city: Required)`. */
  message: string;
  /** Each problem with its path (`(root)` for the whole reply). */
  issues: ToolArgumentIssue[];
}

const jsonSchemas = new WeakMap<StandardSchemaV1, OutputJsonSchemas>();

/** JSON-Schema members that hold a keyed map of subschemas; every other member is a subschema, a list of them, or data. */
const SCHEMA_MAP_MEMBERS = new Set(['$defs', 'definitions', 'dependentSchemas', 'patternProperties', 'properties']);

/** JSON-Schema members that hold a subschema or a list of them; every other member is data (`enum`, `default`, ...). */
const SUBSCHEMA_MEMBERS = new Set([
  'additionalItems',
  'additionalProperties',
  'allOf',
  'anyOf',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'oneOf',
  'prefixItems',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

/** Whether `node` describes an object: an `object` type, or object members without one. */
function isObjectSchemaNode(node: Record<string, unknown>): boolean {
  const type = node.type;
  return (
    type === 'object' ||
    (Array.isArray(type) && type.includes('object')) ||
    'properties' in node ||
    'patternProperties' in node ||
    'additionalProperties' in node
  );
}

/**
 * `schema`, with `additionalProperties: false` on every object node that
 * does not set it (LOU-R7): OpenAI-compatible strict structured-output
 * endpoints reject an object schema without it. zod 3's converter already
 * emits it; zod 4's `toJSONSchema` does not - a plain `z.object` (the
 * documented way) produced an unclosable schema. An explicit
 * `additionalProperties` (`z.strictObject`, `z.looseObject`, `catchall`,
 * `record`) is left alone - it says what the author meant.
 *
 * Strict endpoints also require `required` to list every key of
 * `properties` (audit A6): each optional property is made required and
 * nullable instead, and {@link dropOptionalNulls} turns the model's `null`
 * back into an absent key before validation.
 */
/** `closeObjectSchemas` applied where one member points: a name -> schema map, or a single subschema. */
function closeMember(member: string, value: unknown, root: unknown): void {
  if (SCHEMA_MAP_MEMBERS.has(member)) {
    if (typeof value === 'object' && value !== null) {
      for (const sub of Object.values(value)) closeObjectSchemas(sub, root);
    }
    return;
  }
  if (SUBSCHEMA_MEMBERS.has(member)) {
    closeObjectSchemas(value, root);
  }
}

function closeObjectSchemas(node: unknown, root: unknown = node): void {
  if (Array.isArray(node)) {
    for (const item of node) closeObjectSchemas(item, root);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const schema = node as Record<string, unknown>;
  if (isObjectSchemaNode(schema) && schema.additionalProperties === undefined) {
    schema.additionalProperties = false;
  }
  requireEveryProperty(schema, root);
  for (const [member, value] of Object.entries(schema)) closeMember(member, value, root);
}

/** Every key of `schema.properties` in `required`; each one that was optional also accepts `null` (audit A6). */
function requireEveryProperty(schema: Record<string, unknown>, root: unknown): void {
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return;
  const props = properties as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]) : []);
  for (const [key, sub] of Object.entries(props)) {
    if (!required.has(key) && !admitsNull(sub, root)) props[key] = { anyOf: [sub, { type: 'null' }] };
  }
  schema.required = Object.keys(props);
}

/** The subschema a local `$ref` (`#`, `#/$defs/x`, ...) points at, else `undefined`. */
function resolveRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(1).split('/').filter(Boolean)) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

/** Whether `node` (a subschema of `root`) accepts `null`: a null type, const or enum value, a branch that does, or no constraint at all. */
function admitsNull(node: unknown, root: unknown, refs: ReadonlySet<string> = new Set()): boolean {
  if (node === true) return true;
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
  const schema = node as Record<string, unknown>;
  if (typeof schema.$ref === 'string') {
    return !refs.has(schema.$ref) && admitsNull(resolveRef(root, schema.$ref), root, new Set(refs).add(schema.$ref));
  }
  const type = schema.type;
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) return true;
  if ('const' in schema) return schema.const === null;
  if (Array.isArray(schema.enum)) return schema.enum.includes(null);
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some((branch) => admitsNull(branch, root, refs));
  if (Array.isArray(schema.oneOf)) return schema.oneOf.some((branch) => admitsNull(branch, root, refs));
  if (Array.isArray(schema.allOf)) return schema.allOf.every((branch) => admitsNull(branch, root, refs));
  return type === undefined && !('not' in schema) && !('items' in schema) && !isObjectSchemaNode(schema);
}

/**
 * Removes from `value` (parsed JSON, in place) each `null` that the strict
 * schema allowed only because {@link requireEveryProperty} made an optional
 * property nullable (audit A6). `node` is the unnormalized schema: a key it
 * leaves out of `required` whose own schema rejects `null` is deleted, so
 * the user's `.optional()` schema sees it absent. Walks nested objects,
 * array items, combinator branches and local `$ref`s.
 */
function dropOptionalNulls(value: unknown, node: unknown, root: unknown, refs: ReadonlySet<string> = new Set()): void {
  if (typeof value !== 'object' || value === null) return;
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
  const schema = node as Record<string, unknown>;
  if (typeof schema.$ref === 'string' && !refs.has(schema.$ref)) {
    dropOptionalNulls(value, resolveRef(root, schema.$ref), root, new Set(refs).add(schema.$ref));
  }
  for (const member of ['allOf', 'anyOf', 'oneOf']) {
    const branches = schema[member];
    if (Array.isArray(branches)) for (const branch of branches) dropOptionalNulls(value, branch, root, refs);
  }
  if (Array.isArray(value)) {
    const tuple = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : undefined;
    value.forEach((item, index) => dropOptionalNulls(item, tuple ? (tuple[index] ?? schema.additionalItems) : schema.items, root));
    return;
  }
  const object = value as Record<string, unknown>;
  const properties = (typeof schema.properties === 'object' && schema.properties !== null ? schema.properties : {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]) : []);
  for (const [key, item] of Object.entries(object)) {
    const declared = Object.hasOwn(properties, key);
    const sub = declared ? properties[key] : schema.additionalProperties;
    if (item === null && declared && !required.has(key) && !admitsNull(sub, root)) delete object[key];
    else dropOptionalNulls(item, sub, root);
  }
}

/** The JSON Schema sent to the model, and the schema's own conversion (what {@link dropOptionalNulls} reads). */
interface OutputJsonSchemas {
  strict: Record<string, unknown>;
  original: Record<string, unknown>;
}

/**
 * The schema as JSON Schema, computed once per schema: `z.toJSONSchema` for
 * zod 4 (LOU-D29), the `ai` SDK's zod converter for zod 3. In the copy sent
 * to the model, object nodes are closed (`additionalProperties: false`,
 * LOU-R7) and list every property in `required` (audit A6) for strict
 * structured-output endpoints.
 */
function jsonSchemasOf(schema: StandardSchemaV1): OutputJsonSchemas {
  let json = jsonSchemas.get(schema);
  if (!json) {
    const converted = schemaToJsonSchema(schema) ?? (zodSchema(schema as never).jsonSchema as Record<string, unknown>);
    const original = structuredClone(converted);
    const strict = structuredClone(converted);
    closeObjectSchemas(strict);
    json = { strict, original };
    jsonSchemas.set(schema, json);
  }
  return json;
}

function jsonSchemaOf(schema: StandardSchemaV1): Record<string, unknown> {
  return jsonSchemasOf(schema).strict;
}

/** The system-prompt block that asks for the final answer as JSON matching `schema`. */
export function outputInstruction(schema: StandardSchemaV1): string {
  return [
    '## Output format',
    '',
    'You may call tools first. Your final answer must be only a JSON object (no other text, no code fences) that matches this JSON Schema:',
    '',
    JSON.stringify(jsonSchemaOf(schema)),
  ].join('\n');
}

/** The `responseFormat` hint sent with every model call of the run. */
export function outputResponseFormat(schema: StandardSchemaV1): GenerateOptions['responseFormat'] {
  return { type: 'json', schema: jsonSchemaOf(schema) };
}

/** `text` without surrounding whitespace and a ```/```json code fence. */
function unfence(text: string): string {
  const trimmed = text.trim();
  return /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1] ?? trimmed;
}

/** Parses the final reply as JSON and validates it with `schema`. */
export async function validateOutput(
  schema: StandardSchemaV1,
  text: string
): Promise<{ object: unknown } | { outputError: OutputError }> {
  let value: unknown;
  try {
    value = JSON.parse(unfence(text));
  } catch (error) {
    const issues = [{ path: '(root)', message: `Not valid JSON: ${(error as Error).message}` }];
    return { outputError: { message: `The reply is not a JSON object: ${formatIssues(issues)}`, issues } };
  }
  // Audit A6: `null` for an optional key (made nullable for strict endpoints) means the key is absent.
  const { original } = jsonSchemasOf(schema);
  const cleaned = structuredClone(value);
  dropOptionalNulls(cleaned, original, original);
  let result = await parseWithIssues(schema, cleaned);
  if (!result.success && JSON.stringify(cleaned) !== JSON.stringify(value)) {
    const raw = await parseWithIssues(schema, value);
    if (raw.success) result = raw;
  }
  if (result.success) return { object: result.data };
  const message = `The reply does not match the output schema: ${formatIssues(result.issues)}`;
  return { outputError: { message, issues: result.issues } };
}

/** The user message of the one repair step: the issues, and the ask to answer again. */
export function outputRepairMessage(error: OutputError): Message {
  return {
    role: 'user',
    content: `[output-invalid] ${error.message}. Reply again with only the corrected JSON object.`,
  };
}
