import { describe, it, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import { workspaceManifestObjectSchema, workspaceManifestSchema, type WorkspaceLimits, type WorkspaceManifest } from './workspace';

type Parsed = z.infer<typeof workspaceManifestObjectSchema>;
type ParsedInput = z.input<typeof workspaceManifestObjectSchema>;
type ParsedLimits = NonNullable<NonNullable<Parsed['defaults']>['limits']>;

describe('workspaceManifestSchema types', () => {
  it('infers exactly WorkspaceManifest, in and out', () => {
    expectTypeOf<Parsed>().toEqualTypeOf<WorkspaceManifest>();
    expectTypeOf<WorkspaceManifest>().toEqualTypeOf<Parsed>();
    expectTypeOf<ParsedInput>().toEqualTypeOf<WorkspaceManifest>();
    expectTypeOf<z.infer<typeof workspaceManifestSchema>>().toEqualTypeOf<WorkspaceManifest>();
  });

  it('infers exactly WorkspaceLimits', () => {
    expectTypeOf<ParsedLimits>().toEqualTypeOf<WorkspaceLimits>();
    expectTypeOf<WorkspaceLimits>().toEqualTypeOf<ParsedLimits>();
  });
});
