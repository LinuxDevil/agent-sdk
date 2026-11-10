import { describe, it, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import { narrowPolicy, workspacePolicyObjectSchema, workspacePolicySchema, type EffectivePolicy, type PolicyCeiling, type WorkspacePolicy } from './policy';

type Parsed = z.infer<typeof workspacePolicyObjectSchema>;
type ParsedInput = z.input<typeof workspacePolicyObjectSchema>;

describe('workspacePolicySchema types', () => {
  it('infers exactly WorkspacePolicy, in and out', () => {
    expectTypeOf<Parsed>().toMatchTypeOf<WorkspacePolicy>();
    expectTypeOf<WorkspacePolicy>().toMatchTypeOf<Parsed>();
    expectTypeOf<ParsedInput>().toMatchTypeOf<WorkspacePolicy>();
    expectTypeOf<WorkspacePolicy>().toMatchTypeOf<ParsedInput>();
    expectTypeOf<z.infer<typeof workspacePolicySchema>>().toEqualTypeOf<WorkspacePolicy>();
  });

  it('narrowPolicy takes a ceiling and a policy and returns an EffectivePolicy', () => {
    expectTypeOf(narrowPolicy).toEqualTypeOf<(ceiling: PolicyCeiling, workspace: WorkspacePolicy) => EffectivePolicy>();
  });
});
