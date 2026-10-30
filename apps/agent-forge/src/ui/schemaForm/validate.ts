import { schemaTypes } from './fieldKind';
import { pathKey, resolveRef } from './schemaPath';
import type { JsonSchema, SchemaIssue, SchemaPath } from './types';

const ABSENT = (value: unknown): boolean => value === undefined || value === '';

const issue = (path: SchemaPath, message: string): SchemaIssue => ({ path: pathKey(path), message });

/** `typeof` gate per schema `type`; the value is only keyword-checked after it passes. */
const TYPE_MATCHES: Record<string, (value: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && !Number.isNaN(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

/** The copy shown when a present value fails its `type` gate. */
const TYPE_MESSAGES: Record<string, string> = {
  string: 'Must be text.',
  number: 'Must be a number.',
  integer: 'Must be a whole number.',
  boolean: 'Must be on or off.',
  array: 'Must be a list.',
  object: 'Must be an object.',
};

type NodeCheck = (
  root: JsonSchema,
  schema: JsonSchema,
  value: unknown,
  path: SchemaPath,
  issues: SchemaIssue[],
) => void;

/** Per-type keyword checks, dispatched from {@link validateInto} after the type gate passes. */
const NODE_CHECKS: Record<string, NodeCheck> = {
  string: checkString,
  number: checkNumber,
  integer: checkNumber,
  array: checkArray,
  object: checkObject,
};

/** Numeric bound keywords shared by `number` and `integer`. */
const RANGE_CHECKS: ReadonlyArray<{
  key: 'minimum' | 'maximum' | 'exclusiveMinimum' | 'exclusiveMaximum';
  ok: (value: number, bound: number) => boolean;
  message: (bound: number) => string;
}> = [
  { key: 'minimum', ok: (v, b) => v >= b, message: (b) => `Must be at least ${b}.` },
  { key: 'maximum', ok: (v, b) => v <= b, message: (b) => `Must be at most ${b}.` },
  { key: 'exclusiveMinimum', ok: (v, b) => v > b, message: (b) => `Must be more than ${b}.` },
  { key: 'exclusiveMaximum', ok: (v, b) => v < b, message: (b) => `Must be less than ${b}.` },
];

/** String length keywords. */
const LENGTH_CHECKS: ReadonlyArray<{
  key: 'minLength' | 'maxLength';
  ok: (value: string, bound: number) => boolean;
  message: (bound: number) => string;
}> = [
  { key: 'minLength', ok: (v, b) => v.length >= b, message: (b) => `Must be at least ${b} characters.` },
  { key: 'maxLength', ok: (v, b) => v.length <= b, message: (b) => `Must be at most ${b} characters.` },
];

/**
 * Validates `value` against `schema` (default: the root) in the draft-07
 * subset the form draws. `oneOf`/`anyOf` are not validated (U14); the server
 * re-validates with zod on save. An empty string counts as absent — missing
 * required keys report `Required.`.
 */
export function validateSchemaValue(
  root: JsonSchema,
  value: unknown,
  schema: JsonSchema = root,
  path: SchemaPath = [],
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  validateInto(root, value, schema, path, issues);
  return issues;
}

/** Flattens issues to `{ pathKey: message }` for {@link SchemaForm}'s `errors` prop; first message wins. */
export function issuesByPath(issues: SchemaIssue[]): Record<string, string> {
  const byPath: Record<string, string> = {};
  for (const i of issues) {
    if (byPath[i.path] == null) byPath[i.path] = i.message;
  }
  return byPath;
}

function validateInto(
  root: JsonSchema,
  value: unknown,
  schema: JsonSchema,
  path: SchemaPath,
  issues: SchemaIssue[],
): void {
  const resolved = resolveRef(root, schema);
  if (ABSENT(value)) return;
  if (resolved.enum != null && !resolved.enum.some((v) => Object.is(v, value))) {
    issues.push(issue(path, 'Pick one of the listed values.'));
  }
  const types = schemaTypes(resolved.type);
  const match = types.find((t) => TYPE_MATCHES[t]?.(value) === true);
  if (match == null) {
    const message = types.length > 0 ? TYPE_MESSAGES[types[0]] : undefined;
    if (message != null) issues.push(issue(path, message));
    return;
  }
  NODE_CHECKS[match]?.(root, resolved, value, path, issues);
}

function checkString(
  _root: JsonSchema,
  schema: JsonSchema,
  value: unknown,
  path: SchemaPath,
  issues: SchemaIssue[],
): void {
  const text = value as string;
  for (const check of LENGTH_CHECKS) {
    const bound = schema[check.key];
    if (bound != null && !check.ok(text, bound)) issues.push(issue(path, check.message(bound)));
  }
  const pattern = compilePattern(schema.pattern);
  if (pattern != null && !pattern.test(text)) {
    issues.push(issue(path, 'Doesn’t match the expected format.'));
  }
}

function checkNumber(
  _root: JsonSchema,
  schema: JsonSchema,
  value: unknown,
  path: SchemaPath,
  issues: SchemaIssue[],
): void {
  const n = value as number;
  for (const check of RANGE_CHECKS) {
    const bound = schema[check.key];
    if (bound != null && !check.ok(n, bound)) issues.push(issue(path, check.message(bound)));
  }
}

function checkArray(
  root: JsonSchema,
  schema: JsonSchema,
  value: unknown,
  path: SchemaPath,
  issues: SchemaIssue[],
): void {
  const list = value as unknown[];
  if (schema.minItems != null && list.length < schema.minItems) {
    issues.push(issue(path, `Add at least ${schema.minItems}.`));
  }
  if (schema.maxItems != null && list.length > schema.maxItems) {
    issues.push(issue(path, `At most ${schema.maxItems} allowed.`));
  }
  if (schema.items != null) {
    list.forEach((item, i) => validateInto(root, item, schema.items as JsonSchema, [...path, i], issues));
  }
}

function checkObject(
  root: JsonSchema,
  schema: JsonSchema,
  value: unknown,
  path: SchemaPath,
  issues: SchemaIssue[],
): void {
  const obj = value as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (ABSENT(obj[key])) issues.push(issue([...path, key], 'Required.'));
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    validateInto(root, obj[key], prop, [...path, key], issues);
  }
}

function compilePattern(pattern: string | undefined): RegExp | undefined {
  if (pattern == null) return undefined;
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}
