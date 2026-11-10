import { describe, it, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import { authoringOpSchema, type AuthoringOp } from './authoringOps';

describe('authoringOpSchema types', () => {
  it('infers exactly AuthoringOp', () => {
    expectTypeOf<z.infer<typeof authoringOpSchema>>().toEqualTypeOf<AuthoringOp>();
  });

  it('narrows on op', () => {
    expectTypeOf<Extract<AuthoringOp, { op: 'remove_page' }>>().toEqualTypeOf<{ op: 'remove_page'; page: string }>();
  });
});
