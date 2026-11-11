import { describe, it, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import { pageObjectSchema, pageSchema, WORK_TYPES, type PageExecution, type PageExecutionLimits, type PageManifest, type WorkType } from './page';

type Parsed = z.infer<typeof pageObjectSchema>;
type ParsedInput = z.input<typeof pageObjectSchema>;

describe('pageSchema types', () => {
  it('infers exactly PageManifest, in and out', () => {
    expectTypeOf<Parsed>().toEqualTypeOf<PageManifest>();
    expectTypeOf<PageManifest>().toEqualTypeOf<Parsed>();
    expectTypeOf<ParsedInput>().toEqualTypeOf<PageManifest>();
    expectTypeOf<z.infer<typeof pageSchema>>().toEqualTypeOf<PageManifest>();
  });

  it('infers exactly PageExecution and PageExecutionLimits', () => {
    expectTypeOf<Parsed['execution']>().toEqualTypeOf<PageExecution>();
    expectTypeOf<PageExecution>().toEqualTypeOf<Parsed['execution']>();
    expectTypeOf<NonNullable<Parsed['execution']['limits']>>().toEqualTypeOf<PageExecutionLimits>();
  });

  it('WorkType is the four literals', () => {
    expectTypeOf<WorkType>().toEqualTypeOf<'single' | 'multi-agent' | 'workflow' | 'goal-oriented'>();
    expectTypeOf<(typeof WORK_TYPES)[number]>().toEqualTypeOf<WorkType>();
  });
});
