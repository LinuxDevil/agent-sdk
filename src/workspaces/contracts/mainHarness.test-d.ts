import { describe, it, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import { mainHarnessObjectSchema, mainHarnessSchema, type MainHarness } from './mainHarness';

type Parsed = z.infer<typeof mainHarnessObjectSchema>;
type ParsedInput = z.input<typeof mainHarnessObjectSchema>;

describe('mainHarnessSchema types', () => {
  it('infers exactly MainHarness, in and out', () => {
    expectTypeOf<Parsed>().toEqualTypeOf<MainHarness>();
    expectTypeOf<MainHarness>().toEqualTypeOf<Parsed>();
    expectTypeOf<ParsedInput>().toEqualTypeOf<MainHarness>();
    expectTypeOf<z.infer<typeof mainHarnessSchema>>().toEqualTypeOf<MainHarness>();
  });
});
