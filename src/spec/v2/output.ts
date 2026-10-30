/**
 * The `spec.output` section of AgentSpec v2: a plain JSON Schema object that
 * drives `createAgent({ output })` through the Standard-Schema adapter in
 * jsonSchemaAdapter.ts, plus the OutputSpec options. The SDK closes object
 * schemas for strict endpoints itself, so the section carries no `name` or
 * `strict` keys. Browser-safe: no `node:*` imports.
 */
import { z } from 'zod';
import { isRawJsonSchema } from '../../utils/zodCompat';

/** `spec.output` as data. */
export interface OutputSpecV2 {
  /** The output shape, JSON Schema draft 7 as a plain object. */
  jsonSchema: Record<string, unknown>;
  /** OutputSpec.promptSchema: also write the JSON Schema into the system prompt (default `true`). */
  promptSchema?: boolean;
  /** OutputSpec.responseFormat: which model calls send the schema as `responseFormat` (default `'final'`, or `'always'` with `promptSchema: false`). */
  responseFormat?: 'final' | 'always';
}

/** The `spec.output` section (zod): strict; `jsonSchema` must be a plain JSON Schema object, not a zod or Standard Schema. */
export const outputSpecSchema: z.ZodType<OutputSpecV2> = z
  .object({
    jsonSchema: z.custom<Record<string, unknown>>(isRawJsonSchema, 'output.jsonSchema must be a JSON Schema object'),
    promptSchema: z.boolean().optional(),
    responseFormat: z.enum(['final', 'always']).optional(),
  })
  .strict();
