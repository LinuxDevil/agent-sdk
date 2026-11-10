import { describe, it, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import { workspaceLockObjectSchema, workspaceLockSchema, type WorkspaceLock } from './lock';

type Parsed = z.infer<typeof workspaceLockObjectSchema>;
type ParsedInput = z.input<typeof workspaceLockObjectSchema>;

describe('workspaceLockSchema types', () => {
  it('infers exactly WorkspaceLock, in and out', () => {
    expectTypeOf<Parsed>().toEqualTypeOf<WorkspaceLock>();
    expectTypeOf<WorkspaceLock>().toEqualTypeOf<Parsed>();
    expectTypeOf<ParsedInput>().toEqualTypeOf<WorkspaceLock>();
    expectTypeOf<z.infer<typeof workspaceLockSchema>>().toEqualTypeOf<WorkspaceLock>();
  });
});
