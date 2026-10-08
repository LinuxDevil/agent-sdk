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
  if (!isZod4Schema(schema)) return [];
  const paths: string[] = [];
  toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
    unrepresentable: 'any',
    override: ({ zodSchema, path }) => {
      const def = zodSchema._zod.def as { type: string; coerce?: boolean };
      if (def.type !== 'date' || def.coerce) return;
      const parts = path.filter((part) => part !== 'properties' && part !== 'anyOf' && part !== 'oneOf' && typeof part !== 'number');
      paths.push(parts.map(String).join('.').replace(/\.items/g, '[]').replace(/^items/, '[]') || '(root)');
    },
  });
  return paths.sort();
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
