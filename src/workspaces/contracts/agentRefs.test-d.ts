import { describe, it, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import { attachmentsObjectSchema, attachmentsSchema, type Attachments } from './agentRefs';

describe('attachmentsSchema types', () => {
  it('infers exactly Attachments', () => {
    expectTypeOf<z.infer<typeof attachmentsObjectSchema>>().toEqualTypeOf<Attachments>();
    expectTypeOf<Attachments>().toEqualTypeOf<z.infer<typeof attachmentsObjectSchema>>();
    expectTypeOf<z.infer<typeof attachmentsSchema>>().toEqualTypeOf<Attachments>();
  });
});
