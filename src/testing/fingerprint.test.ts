import { describe, expect, it } from 'vitest';
import * as z3 from 'zod/v3';
import * as z4 from 'zod/v4';
import { stableStringify } from './fingerprint';

// A cassette stores a tool's parameters as a fingerprint of the zod schema. The same schema written
// with zod 3 or zod 4 must give the same fingerprint, or a cassette recorded under one major fails
// to replay under the other (the CI peers jobs with zod 4 did exactly that).
describe('tool schema fingerprint across zod majors', () => {
  it('is the same for zod 3 and zod 4 schemas of the same shape', () => {
    const v3 = z3.object({
      path: z3.string().min(1).describe('A path'),
      limit: z3.number().int().min(1).optional().describe('Max lines'),
      all: z3.boolean().optional(),
      mode: z3.enum(['a', 'b']),
      tags: z3.array(z3.string()),
      kind: z3.literal('k'),
    });
    const v4 = z4.object({
      path: z4.string().min(1).describe('A path'),
      limit: z4.number().int().min(1).optional().describe('Max lines'),
      all: z4.boolean().optional(),
      mode: z4.enum(['a', 'b']),
      tags: z4.array(z4.string()),
      kind: z4.literal('k'),
    });
    expect(stableStringify(v4)).toBe(stableStringify(v3));
  });

  it('does not emit JSON Schema markers such as $schema for a zod 4 schema', () => {
    expect(stableStringify(z4.object({ a: z4.string() }))).not.toContain('$schema');
  });

  it('still tells real differences apart', () => {
    const base = stableStringify(z4.object({ a: z4.string().describe('x') }));
    expect(stableStringify(z4.object({ a: z4.number().describe('x') }))).not.toBe(base);
    expect(stableStringify(z4.object({ a: z4.string().describe('y') }))).not.toBe(base);
    expect(stableStringify(z4.object({ a: z4.string().optional().describe('x') }))).not.toBe(base);
    expect(stableStringify(z4.object({ b: z4.string().describe('x') }))).not.toBe(base);
    expect(stableStringify(z4.object({ a: z4.string().min(2).describe('x') }))).not.toBe(base);
  });
});
