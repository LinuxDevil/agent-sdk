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

const jsonSchemas = new WeakMap<StandardSchemaV1, Record<string, unknown>>();

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

function isSchemaMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `node` already accepts `null`, so marking its property `required` needs no `| null` union. */
function acceptsNull(node: unknown): boolean {
  if (node === true) return true;
  if (!isSchemaMap(node)) return false;
  const type = node.type;
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) return true;
  if (node.const === null || (Array.isArray(node.enum) && node.enum.includes(null))) return true;
  for (const member of ['anyOf', 'oneOf'] as const) {
    const subs = node[member];
    if (Array.isArray(subs) && subs.some(acceptsNull)) return true;
  }
  // An unconstrained schema ({}, a bare description, ...) accepts anything.
  return !('type' in node) && !('const' in node) && !('enum' in node) && !('anyOf' in node) && !('oneOf' in node) && !('allOf' in node) && !('$ref' in node) && !('not' in node);
}

/**
 * The `{anyOf: [<original>, {type:'null'}]}` wrappers `closeObjectSchemas`
 * adds for formerly-optional properties (LOU-R7.2): strict endpoints cannot
 * omit a key, so the model writes `null` for an absent optional field while
 * the source schema still rejects it - `validateOutput` turns that `null`
 * back into an absent key before validating.
 */
const widenedToNullable = new WeakSet<object>();

/**
 * `schema`, with `additionalProperties: false` on every object node that
 * does not set it (LOU-R7): OpenAI-compatible strict structured-output
 * endpoints reject an object schema without it. zod 3's converter already
 * emits it; zod 4's `toJSONSchema` does not - a plain `z.object` (the
 * documented way) produced an unclosable schema. An explicit
 * `additionalProperties` (`z.strictObject`, `z.looseObject`, `catchall`,
 * `record`) is left alone - it says what the author meant.
 */
/** `closeObjectSchemas` applied where one member points: a name -> schema map, or a single subschema. */
function closeMember(member: string, value: unknown): void {
  if (SCHEMA_MAP_MEMBERS.has(member)) {
    if (typeof value === 'object' && value !== null) {
      for (const sub of Object.values(value)) closeObjectSchemas(sub);
    }
    return;
  }
  if (SUBSCHEMA_MEMBERS.has(member)) {
    closeObjectSchemas(value);
  }
}

function closeObjectSchemas(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) closeObjectSchemas(item);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const schema = node as Record<string, unknown>;
  if (isObjectSchemaNode(schema) && schema.additionalProperties === undefined) {
    schema.additionalProperties = false;
  }
  // LOU-R7.2: strict structured outputs also require `required` to list
  // every key of `properties`; a key the source schema left optional (a zod
  // `.optional()`/`.default()` produces exactly that) keeps its slot by
  // becoming a `... | null` union - which is also how the model reports
  // "absent", since the strict response cannot omit the key.
  const properties = schema.properties;
  if (isSchemaMap(properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const key of Object.keys(properties)) {
      if (required.has(key)) continue;
      required.add(key);
      if (!acceptsNull(properties[key])) {
        const widened = { anyOf: [properties[key], { type: 'null' }] };
        widenedToNullable.add(widened);
        properties[key] = widened;
      }
    }
    schema.required = [...required];
  }
  for (const [member, value] of Object.entries(schema)) closeMember(member, value);
}

/**
 * The schema as JSON Schema, computed once per schema: `z.toJSONSchema` for
 * zod 4 (LOU-D29), the `ai` SDK's zod converter for zod 3. Object nodes are
 * closed (`additionalProperties: false`) for strict structured-output
 * endpoints (LOU-R7).
 */
function jsonSchemaOf(schema: StandardSchemaV1): Record<string, unknown> {
  let json = jsonSchemas.get(schema);
  if (!json) {
    json = schemaToJsonSchema(schema) ?? (zodSchema(schema as never).jsonSchema as Record<string, unknown>);
    closeObjectSchemas(json);
    jsonSchemas.set(schema, json);
  }
  return json;
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

/** The schema a local `#/a/b` $ref points at, or `undefined` when it cannot be resolved. */
function resolveLocalRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let target: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    if (!isSchemaMap(target)) return undefined;
    target = target[segment];
  }
  return target;
}

/**
 * Walks `value` (the parsed reply) alongside the sent JSON schema and
 * deletes every `null` sitting in a property `closeObjectSchemas` widened
 * to `... | null` (the markers are in {@link widenedToNullable}): under a
 * strict `required` the model has to write `null` for an absent optional
 * field, but the source schema - a zod `.optional()` - still wants the key
 * gone. A genuinely `.nullable()` field is untouched: its `null` is real.
 */
function stripWidenedNulls(value: unknown, node: unknown, root: unknown): void {
  if (!isSchemaMap(node)) return;
  const ref = node.$ref;
  if (typeof ref === 'string') stripWidenedNulls(value, resolveLocalRef(root, ref), root);
  if (Array.isArray(value)) {
    for (const item of value) stripWidenedNulls(item, node.items, root);
    const prefix = node.prefixItems;
    if (Array.isArray(prefix)) prefix.forEach((subschema, index) => stripWidenedNulls(value[index], subschema, root));
  } else if (isSchemaMap(value)) {
    const properties = isSchemaMap(node.properties) ? node.properties : {};
    for (const [key, prop] of Object.entries(properties)) {
      if (!(key in value)) continue;
      if (value[key] === null && widenedToNullable.has(prop as object)) delete value[key];
      else stripWidenedNulls(value[key], prop, root);
    }
    if (isSchemaMap(node.additionalProperties)) {
      for (const [key, item] of Object.entries(value)) {
        if (!(key in properties)) stripWidenedNulls(item, node.additionalProperties, root);
      }
    }
    if (isSchemaMap(node.patternProperties)) {
      for (const [pattern, subschema] of Object.entries(node.patternProperties)) {
        for (const [key, item] of Object.entries(value)) {
          if (new RegExp(pattern).test(key)) stripWidenedNulls(item, subschema, root);
        }
      }
    }
  }
  for (const member of ['anyOf', 'oneOf', 'allOf'] as const) {
    const subs = node[member];
    if (Array.isArray(subs)) for (const subschema of subs) stripWidenedNulls(value, subschema, root);
  }
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
  const json = jsonSchemaOf(schema);
  stripWidenedNulls(value, json, json);
  const result = await parseWithIssues(schema, value);
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
