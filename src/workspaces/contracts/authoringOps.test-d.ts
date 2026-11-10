import { describe, it, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import { authoringOpObjectSchema, authoringOpSchema, type AuthoringOp } from './authoringOps';

type Parsed = z.infer<typeof authoringOpObjectSchema>;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type PerOp = { [N in AuthoringOp['op']]: Mutual<Extract<AuthoringOp, { op: N }>, Extract<Parsed, { op: N }>> };

describe('authoringOpSchema types', () => {
  it('infers an AuthoringOp, in and out', () => {
    expectTypeOf<Parsed>().toMatchTypeOf<AuthoringOp>();
    expectTypeOf<AuthoringOp>().toMatchTypeOf<Parsed>();
    expectTypeOf<z.infer<typeof authoringOpSchema>>().toEqualTypeOf<AuthoringOp>();
  });

  it('matches the inferred type for every op', () => {
    expectTypeOf<PerOp[keyof PerOp]>().toEqualTypeOf<true>();
  });

  it('notices a field added to only one side', () => {
    expectTypeOf<Mutual<{ op: 'x'; page: string }, { op: 'x'; page: string; extra: string }>>().toEqualTypeOf<false>();
  });
});
