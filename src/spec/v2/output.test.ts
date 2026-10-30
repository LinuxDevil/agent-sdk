/**
 * The `spec.output` section: a strict `{ jsonSchema, promptSchema?,
 * responseFormat? }` where jsonSchema must be a plain JSON Schema object, not
 * a zod or Standard Schema (isRawJsonSchema).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../../execution/errors';
import { outputSpecSchema } from './output';
import { parseAgentSpecV2 } from './parse';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };
const jsonSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

function thrown(data: unknown): ValidationError {
  try {
    parseAgentSpecV2(data);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error('expected parseAgentSpecV2 to throw');
}

describe('spec v2 output', () => {
  it('accepts { jsonSchema } alone and with the OutputSpec options', () => {
    expect(parseAgentSpecV2({ ...base, output: { jsonSchema } }).output).toEqual({ jsonSchema });
    expect(outputSpecSchema.safeParse({ jsonSchema, promptSchema: false, responseFormat: 'always' }).success).toBe(true);
  });

  it("rejects the PLAN-era 'name' and 'strict' keys as unknown", () => {
    const error = thrown({ ...base, output: { jsonSchema, name: 'answer', strict: true } });
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.errors).toHaveProperty('output');
    expect(error.message).toContain('name');
    expect(error.message).toContain('strict');
    expect(outputSpecSchema.safeParse({ jsonSchema, name: 'x' }).success).toBe(false);
    expect(outputSpecSchema.safeParse({ jsonSchema, strict: true }).success).toBe(false);
  });

  it('rejects a zod schema in jsonSchema', () => {
    const error = thrown({ ...base, output: { jsonSchema: z.string() } });
    expect(error.errors).toHaveProperty('output.jsonSchema');
    expect(error.message).toContain('must be a JSON Schema object');
    expect(outputSpecSchema.safeParse({ jsonSchema: z.string() }).success).toBe(false);
  });
});
