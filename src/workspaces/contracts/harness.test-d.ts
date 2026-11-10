import { describe, it, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import { harnessObjectSchema, harnessProfileObjectSchema, harnessProfileSchema, harnessSchema, type Harness, type HarnessProfile } from './harness';

type Parsed = z.infer<typeof harnessObjectSchema>;
type ParsedProfile = z.infer<typeof harnessProfileObjectSchema>;

describe('harnessSchema types', () => {
  it('infers exactly Harness, in and out', () => {
    expectTypeOf<Parsed>().toEqualTypeOf<Harness>();
    expectTypeOf<Harness>().toEqualTypeOf<Parsed>();
    expectTypeOf<z.input<typeof harnessObjectSchema>>().toEqualTypeOf<Harness>();
    expectTypeOf<z.infer<typeof harnessSchema>>().toEqualTypeOf<Harness>();
  });

  it('infers exactly HarnessProfile', () => {
    expectTypeOf<ParsedProfile>().toEqualTypeOf<HarnessProfile>();
    expectTypeOf<HarnessProfile>().toEqualTypeOf<ParsedProfile>();
    expectTypeOf<z.infer<typeof harnessProfileSchema>>().toEqualTypeOf<HarnessProfile>();
  });
});
