import { describe, it, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import { goalObjectSchema, goalSchema, type GoalSpec } from './contract';

type Parsed = z.infer<typeof goalObjectSchema>;

describe('goalSchema types', () => {
  it('infers exactly GoalSpec, in and out', () => {
    expectTypeOf<Parsed>().toEqualTypeOf<GoalSpec>();
    expectTypeOf<GoalSpec>().toEqualTypeOf<Parsed>();
    expectTypeOf<z.infer<typeof goalSchema>>().toEqualTypeOf<GoalSpec>();
  });
});
