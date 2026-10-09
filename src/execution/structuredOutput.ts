/**
 * Structured output (LOU-V4): what a run with `ExecuteOptions.output` adds
 * to the request (an instruction in the system prompt and a
 * `responseFormat` hint), and the parse/validate/repair of its final reply.
 */

import { zodSchema } from 'ai';
import type { GenerateOptions, Message } from '../providers';
import { formatIssues, parseWithIssues, type ToolArgumentIssue } from './toolArgsValidation';
import { isModelSchema, schemaToJsonSchema, unrepresentableDates, type StandardSchemaV1 } from '../utils/zodCompat';
import { ConfigurationError } from './errors';
import { decodeStrictValue, resolveRef, rewriteStrictShapes, type StrictShapes } from './strictShapes';

/** Why a run's final reply is not a valid `output` object (`finishReason: 'output-invalid'`). */
export interface OutputError {
  /**
   * `'truncated'` when the reply was cut off at the `maxTokens` limit (its
   * `finishReason` was `'length'`) before the JSON was complete: no repair
   * call is made, since it would be cut off the same way - raise
   * `modelSettings.maxTokens` (Eve CORE-F12). `'invalid'` otherwise.
   */
  kind: 'invalid' | 'truncated';
  /** Model-readable summary, e.g. `The reply does not match the output schema: 1 issue (city: Required)`. */
  message: string;
  /** Each problem with its path (`(root)` for the whole reply). */
  issues: ToolArgumentIssue[];
}

/**
 * `ExecuteOptions.output` / `createAgent({ output })` as an options object
 * instead of a bare schema (audit invoice F12). `promptSchema: false` leaves
 * the JSON Schema out of the system prompt: it is sent only on
 * `GenerateOptions.responseFormat`, so a provider that enforces it no longer
 * pays for the schema twice (~1k prompt tokens a call on a large one). Keep
 * the default (`true`, or a bare `output: schema`) when the provider takes
 * `responseFormat` as a JSON-mode hint only - the prompt copy is then the
 * only place the model sees the shape to answer with.
 */
export interface OutputSpec<TSchema extends StandardSchemaV1 = StandardSchemaV1> {
  /** The schema the final reply is validated into `result.object` with (what a bare `output` is). */
  schema: TSchema;
  /** Also write the JSON Schema into the system prompt (default `true`). */
  promptSchema?: boolean;
}

/** `output` given as an {@link OutputSpec} vs a bare schema: the spec has a `schema` key and is not itself a schema. */
function isOutputSpec(output: StandardSchemaV1 | OutputSpec): output is OutputSpec {
  return isRecord(output) && 'schema' in output && !('~standard' in output) && !isModelSchema(output);
}

/** The schema of an `output` option - `output` itself, or `output.schema` of the spec form. */
function outputSchemaOf(output: StandardSchemaV1 | OutputSpec): StandardSchemaV1 {
  return isOutputSpec(output) ? output.schema : output;
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
  /** The nodes of `strict` rewritten for strict endpoints (Eve PROV-F1), which a reply is decoded through. */
  shapes: StrictShapes;
}

/**
 * The schema as JSON Schema, computed once per schema: `z.toJSONSchema` for
 * zod 4 (LOU-D29), the `ai` SDK's zod converter for zod 3. In the copy sent
 * to the model, object nodes are closed (`additionalProperties: false`,
 * LOU-R7) and list every property in `required` (audit A6) for strict
 * structured-output endpoints. Shapes strict endpoints reject (`oneOf`,
 * records, tuples, a root that is not an object) are then rewritten (Eve
 * PROV-F1, see `strictShapes.ts`).
 */
function jsonSchemasOf(schema: StandardSchemaV1): OutputJsonSchemas {
  let json = jsonSchemas.get(schema);
  if (!json) {
    assertNoDates(schema);
    const converted = schemaToJsonSchema(schema) ?? (zodSchema(schema as never).jsonSchema as Record<string, unknown>);
    const original = structuredClone(converted);
    const strict = structuredClone(converted);
    closeObjectSchemas(strict);
    const shapes = rewriteStrictShapes(strict);
    json = { strict, original, shapes };
    jsonSchemas.set(schema, json);
  }
  return json;
}

/**
 * Audit invoice F8: a zod 4 `z.date()` has no JSON form - it was sent as
 * `{}` and no JSON reply could ever validate it. Throws a
 * ConfigurationError naming each such field.
 */
function assertNoDates(schema: StandardSchemaV1): void {
  const paths = unrepresentableDates(schema);
  if (paths.length === 0) return;
  throw new ConfigurationError(
    `output: ${paths.map((path) => `'${path}'`).join(', ')} ${paths.length === 1 ? 'is a' : 'are'} z.date(), which JSON cannot carry, ` +
      'so no reply could validate. Use z.iso.date() or z.iso.datetime() (an ISO string), ' +
      'or z.iso.datetime().pipe(z.coerce.date()) for a Date.',
    'output'
  );
}

/**
 * Throws a ConfigurationError when `schema` cannot be used as `output` (a
 * `z.date()` field), so
 * `createAgent()` and `AgentExecutor.execute()` fail at once rather than
 * on the first model call.
 */
export function assertOutputSchema(schema: StandardSchemaV1 | OutputSpec | undefined): void {
  if (schema) jsonSchemasOf(outputSchemaOf(schema));
}

function jsonSchemaOf(schema: StandardSchemaV1): Record<string, unknown> {
  return jsonSchemasOf(schema).strict;
}

/**
 * The system-prompt block that asks for the final answer as JSON matching
 * `schema`. An `output` spec's `promptSchema: false` leaves the schema itself
 * out (audit invoice F12): the ask to answer with only JSON stays, the copy
 * `responseFormat` already carries does not.
 */
export function outputInstruction(output: StandardSchemaV1 | OutputSpec): string {
  if (isOutputSpec(output) && output.promptSchema === false) {
    return ['## Output format', '', 'You may call tools first. Your final answer must be only a JSON object (no other text, no code fences).'].join(
      '\n'
    );
  }
  return [
    '## Output format',
    '',
    'You may call tools first. Your final answer must be only a JSON object (no other text, no code fences) that matches this JSON Schema:',
    '',
    JSON.stringify(jsonSchemaOf(outputSchemaOf(output))),
  ].join('\n');
}

/** The `responseFormat` hint sent with every model call of the run. */
export function outputResponseFormat(output: StandardSchemaV1 | OutputSpec): GenerateOptions['responseFormat'] {
  return { type: 'json', schema: jsonSchemaOf(outputSchemaOf(output)) };
}

/** `text` without surrounding whitespace and a ```/```json code fence. */
function unfence(text: string): string {
  const trimmed = text.trim();
  return /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1] ?? trimmed;
}

/** `text` without `<think>`/`<thinking>` blocks, and without what precedes a stray closing tag. */
function withoutThinking(text: string): string {
  const stripped = text.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '');
  const close = /<\/think(?:ing)?>/gi;
  let end = -1;
  for (let match = close.exec(stripped); match; match = close.exec(stripped)) end = match.index + match[0].length;
  return end < 0 ? stripped : stripped.slice(end);
}

/** How many opening brackets {@link balancedSlices} tries before it gives up on a long prose reply. */
const MAX_JSON_STARTS = 20;

/**
 * Each balanced `{...}`/`[...]` substring of `text`, left to right. The
 * caller passes `true` to `next()` when the last one parsed as JSON, and
 * the search goes on after it rather than inside it.
 */
function* balancedSlices(text: string): Generator<string, void, boolean | undefined> {
  let starts = 0;
  for (let start = 0; start < text.length && starts < MAX_JSON_STARTS; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    starts++;
    const end = balancedEnd(text, start);
    if (end < 0) continue;
    const parsed = yield text.slice(start, end + 1);
    if (parsed) start = end;
  }
}

/** The index of the bracket that closes the one at `start` (strings and escapes respected), else -1. */
function balancedEnd(text: string, start: number): number {
  const closers: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') closers.push('}');
    else if (char === '[') closers.push(']');
    else if (char === '}' || char === ']') {
      if (closers.pop() !== char) return -1;
      if (closers.length === 0) return i;
    }
  }
  return -1;
}

function tryParse(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/**
 * The JSON values a final reply holds, best first (audit log F8): the whole
 * reply (a code fence around it tolerated). Only when that is not JSON - a
 * near miss - then, with `<think>` blocks removed: the rest, each fenced
 * block, and each balanced object or array. A prose prefix, trailing prose
 * or a reasoning block then validates without a repair call.
 */
function* jsonCandidates(text: string): Generator<unknown> {
  const whole = tryParse(unfence(text));
  if (whole) {
    yield whole.value;
    return;
  }
  const body = withoutThinking(text);
  const tried = new Set<string>();
  const parse = (slice: string): { value: unknown } | undefined => {
    if (tried.has(slice)) return undefined;
    tried.add(slice);
    return tryParse(slice);
  };
  const fenced = [...body.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
  for (const slice of [unfence(body), ...fenced]) {
    const parsed = parse(slice);
    if (parsed) yield parsed.value;
  }
  const slices = balancedSlices(body);
  for (let next = slices.next(); !next.done; ) {
    const parsed = parse(next.value);
    if (parsed) yield parsed.value;
    next = slices.next(parsed !== undefined);
  }
}

/** A reply that does not validate: why, and whether it was the JSON Schema itself (audit docs-qa F9). */
export interface OutputFailure {
  outputError: OutputError;
  schemaEcho?: true;
}

/**
 * Validates one parsed reply with `schema`: decoded from the strict shape
 * (Eve PROV-F1: a wrapped root, `{ key, value }` records, `_0`.. tuples)
 * and with an optional key sent as `null` absent (audit A6). When that
 * does not validate, the decoded and then the raw reply are tried as sent.
 */
async function validateValue(schema: StandardSchemaV1, value: unknown): Promise<{ object: unknown } | OutputFailure> {
  const { original, strict, shapes } = jsonSchemasOf(schema);
  const decoded = decodeStrictValue(value, strict, strict, shapes);
  const cleaned = structuredClone(decoded);
  dropOptionalNulls(cleaned, original, original);
  let result = await parseWithIssues(schema, cleaned);
  for (const candidate of [decoded, value]) {
    if (result.success) break;
    if (JSON.stringify(candidate) === JSON.stringify(cleaned)) continue;
    const raw = await parseWithIssues(schema, candidate);
    if (raw.success) result = raw;
  }
  if (result.success) return { object: result.data };
  if (isSchemaEcho(value, strict)) {
    const issues = [{ path: '(root)', message: 'This is the output JSON Schema itself, not an answer that follows it' }];
    return { outputError: { kind: 'invalid', message: `The reply is the JSON Schema, not data: ${formatIssues(issues)}`, issues }, schemaEcho: true };
  }
  const message = `The reply does not match the output schema: ${formatIssues(result.issues)}`;
  return { outputError: { kind: 'invalid', message, issues: result.issues } };
}

/**
 * Parses the final reply as JSON - or the JSON in a near miss, see
 * {@link jsonCandidates} - and validates it with `schema`. The first
 * candidate that validates wins; otherwise the issues are the first
 * parsed candidate's.
 */
export async function validateOutput(
  output: StandardSchemaV1 | OutputSpec,
  text: string
): Promise<{ object: unknown } | OutputFailure> {
  const schema = outputSchemaOf(output);
  let first: OutputFailure | undefined;
  for (const value of jsonCandidates(text)) {
    const checked = await validateValue(schema, value);
    if ('object' in checked) return checked;
    first ??= checked;
  }
  if (first) return first;
  let reason = 'no JSON found';
  try {
    JSON.parse(unfence(text));
  } catch (error) {
    reason = (error as Error).message;
  }
  const issues = [{ path: '(root)', message: `Not valid JSON: ${reason}` }];
  return { outputError: { kind: 'invalid', message: `The reply is not a JSON object: ${formatIssues(issues)}`, issues } };
}

/**
 * Eve CORE-F12: `failure` of a reply the model ended with `finishReason:
 * 'length'` - cut off at the `maxTokens` limit, so a repair call would be
 * cut off the same way. Kind `'truncated'`, with the hint to raise the limit.
 */
export function truncatedOutput(failure: OutputFailure): OutputError {
  return {
    kind: 'truncated',
    message:
      `The reply was cut off at the maxTokens limit (finishReason 'length') before the JSON was complete: ` +
      `${failure.outputError.message}. Raise modelSettings.maxTokens.`,
    issues: failure.outputError.issues,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `value` is the sent JSON Schema echoed back (audit docs-qa F9): a
 * `$schema` key, or a `properties` map of subschemas over the schema's own
 * property names next to an object `type` or a `required` list.
 */
function isSchemaEcho(value: unknown, sent: Record<string, unknown>): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.$schema === 'string') return true;
  const { properties } = value;
  const sentProperties = sent.properties;
  if (!isRecord(properties) || !isRecord(sentProperties)) return false;
  if (value.type !== 'object' && !Array.isArray(value.required)) return false;
  const keys = Object.keys(properties);
  return keys.length > 0 && keys.every((key) => Object.hasOwn(sentProperties, key) && isRecord(properties[key]));
}

/** How deep {@link exampleOf} renders nested and recursive schemas before it writes `null`. */
const MAX_EXAMPLE_DEPTH = 8;

/** The placeholder {@link exampleOf} writes for each JSON type. */
const EXAMPLE_VALUES: Record<string, unknown> = { string: '<string>', number: 0, integer: 0, boolean: true, null: null };

/** An example instance of `node` (a subschema of `root`): the shape to answer with, placeholders for the values. */
function exampleOf(node: unknown, root: unknown, depth = 0): unknown {
  if (!isRecord(node) || depth > MAX_EXAMPLE_DEPTH) return null;
  if (typeof node.$ref === 'string') return exampleOf(resolveRef(root, node.$ref), root, depth + 1);
  if ('const' in node) return node.const;
  if (Array.isArray(node.enum)) return node.enum[0];
  for (const member of ['anyOf', 'oneOf', 'allOf']) {
    const branches = node[member];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const branch = branches.find((item) => !(isRecord(item) && item.type === 'null')) ?? branches[0];
    return exampleOf(branch, root, depth + 1);
  }
  const type = Array.isArray(node.type) ? (node.type.find((item) => item !== 'null') ?? 'null') : node.type;
  if (type === 'array') {
    const tuple = Array.isArray(node.prefixItems) ? node.prefixItems : Array.isArray(node.items) ? node.items : undefined;
    return tuple ? tuple.map((item) => exampleOf(item, root, depth + 1)) : [exampleOf(node.items, root, depth + 1)];
  }
  if (type === 'object' || isObjectSchemaNode(node)) {
    const properties = isRecord(node.properties) ? node.properties : {};
    return Object.fromEntries(Object.entries(properties).map(([key, sub]) => [key, exampleOf(sub, root, depth + 1)]));
  }
  if (type === 'string' && node.format === 'date') return '2026-01-31';
  if (type === 'string' && node.format === 'date-time') return '2026-01-31T12:00:00Z';
  return typeof type === 'string' && type in EXAMPLE_VALUES ? EXAMPLE_VALUES[type] : null;
}

/**
 * The user message of the one repair step: the issues, and the ask to
 * answer again. When the reply echoed the JSON Schema (audit docs-qa F9),
 * it says so and shows an example instance rather than the schema again.
 */
export function outputRepairMessage(output: StandardSchemaV1 | OutputSpec, failure: OutputFailure): Message {
  if (failure.schemaEcho) {
    const sent = jsonSchemaOf(outputSchemaOf(output));
    return {
      role: 'user',
      content:
        '[output-invalid] Your reply is the JSON Schema itself. Do not repeat the schema: reply with only a JSON object ' +
        `holding your actual answer, shaped like this example (placeholders for the values): ${JSON.stringify(exampleOf(sent, sent))}`,
    };
  }
  return {
    role: 'user',
    content: `[output-invalid] ${failure.outputError.message}. Reply again with only the corrected JSON object.`,
  };
}
