/**
 * A spec's plain JSON Schema object as a Standard Schema: `~standard.validate`
 * checks a value with the permissive jsonSchemaToZod() conversion, and
 * `~standard.jsonSchema.input()` returns the author's schema itself (a deep
 * copy), so schemaToJsonSchema() hands providers the exact JSON Schema the
 * spec wrote instead of a re-derived one. Browser-safe: zod only.
 */
import type { OutputSpec } from '../../execution/structuredOutput';
import { jsonSchemaToZod } from '../../tools/mcp/schema';
import { issueMessage, type SchemaIssue, type StandardSchemaV1 } from '../../utils/zodCompat';
import type { OutputSpecV2 } from './output';

/** One issue path segment flattened to a string or number (zod 4 can report a `{ key }` object or a symbol). */
function pathSegment(segment: PropertyKey | { readonly key: PropertyKey }): string | number {
  const key = typeof segment === 'object' ? segment.key : segment;
  return typeof key === 'string' || typeof key === 'number' ? key : String(key);
}

/** A zod issue as a Standard Schema issue: the message worded the same on both majors, the path flattened. */
function toStandardIssue(issue: SchemaIssue): { message: string; path: (string | number)[] } {
  return { message: issueMessage(issue), path: (issue.path ?? []).map(pathSegment) };
}

/**
 * A Standard Schema over a plain JSON Schema: `~standard.validate` checks a value with
 * `jsonSchemaToZod(schema)`, and `~standard.jsonSchema.input()` returns `schema` itself (a deep copy),
 * so `schemaToJsonSchema()` hands providers the author's exact schema.
 */
export function jsonSchemaToStandardSchema(schema: Record<string, unknown>): StandardSchemaV1<unknown, unknown> & {
  /** The Standard Schema protocol object, extended with a `jsonSchema` renderer. */
  readonly '~standard': StandardSchemaV1['~standard'] & {
    /** Renders the author's JSON Schema itself (a deep copy) for either direction. */
    readonly jsonSchema: {
      /** The input JSON Schema: `schema` as written (the `target` option is ignored). */
      input(options?: { target?: string }): Record<string, unknown>;
      /** The output JSON Schema: the same as the input for this adapter. */
      output(options?: { target?: string }): Record<string, unknown>;
    };
  };
} {
  const zodSchema = jsonSchemaToZod(schema);
  const standard = {
    version: 1 as const,
    vendor: 'lousho-json-schema',
    validate: (value: unknown): { readonly value: unknown } | { readonly issues: readonly SchemaIssue[] } => {
      const parsed = zodSchema.safeParse(value);
      return parsed.success ? { value: parsed.data } : { issues: parsed.error.issues.map(toStandardIssue) };
    },
    jsonSchema: {
      // The argument is ignored: this schema renders the same for every target.
      input: () => structuredClone(schema),
      output: () => structuredClone(schema),
    },
  };
  Object.freeze(standard.jsonSchema);
  Object.freeze(standard);
  return Object.freeze({ '~standard': standard });
}

/** `spec.output` → `createAgent({ output })`. */
export function outputFromSpec(output: OutputSpecV2): OutputSpec {
  const { jsonSchema, promptSchema, responseFormat } = output;
  return {
    schema: jsonSchemaToStandardSchema(jsonSchema),
    ...(promptSchema !== undefined && { promptSchema }),
    ...(responseFormat !== undefined && { responseFormat }),
  };
}
