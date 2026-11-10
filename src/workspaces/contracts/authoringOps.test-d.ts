import { describe, it, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import { authoringOpObjectSchema, authoringOpSchema, type AuthoringOp } from './authoringOps';

type Parsed = z.infer<typeof authoringOpObjectSchema>;

describe('authoringOpSchema types', () => {
  it('infers exactly AuthoringOp, in and out', () => {
    expectTypeOf<Parsed>().toEqualTypeOf<AuthoringOp>();
    expectTypeOf<AuthoringOp>().toEqualTypeOf<Parsed>();
    expectTypeOf<z.input<typeof authoringOpObjectSchema>>().toEqualTypeOf<AuthoringOp>();
    expectTypeOf<z.infer<typeof authoringOpSchema>>().toEqualTypeOf<AuthoringOp>();
  });
});
