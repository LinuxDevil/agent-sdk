import { describe, it, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import type { PageInput, PageRunEvent } from '../contracts/execution';
import type { AuthoringOp } from '../contracts/authoringOps';
import type { PageUi } from '../contracts/ui';
import type { WorkspaceProblem } from '../contracts/validate';
import type { ApiClient, RouteInput } from './apiClient';
import { WORKSPACE_ROUTES } from './wire';
import type { ApplyOpsBody, DraftView, PageRunView, PageUiView, ProblemView, WireRunEvent, WorkspaceRouteTypes } from './index';
import { pageInputSchema, pageRunEventSchema, wireRunEventSchema } from './wireSchemas';

describe('wire contract types', () => {
  it('reuses the contract types instead of redefining them', () => {
    expectTypeOf<z.infer<typeof pageInputSchema>>().toEqualTypeOf<PageInput>();
    expectTypeOf<z.infer<typeof pageRunEventSchema>>().toEqualTypeOf<PageRunEvent>();
    expectTypeOf<z.infer<typeof wireRunEventSchema>>().toEqualTypeOf<WireRunEvent>();
    expectTypeOf<WireRunEvent['event']>().toEqualTypeOf<PageRunEvent>();
    expectTypeOf<ApplyOpsBody['ops']>().toEqualTypeOf<AuthoringOp[]>();
    expectTypeOf<DraftView['operations']>().toEqualTypeOf<AuthoringOp[]>();
    expectTypeOf<PageUiView['ui']>().toEqualTypeOf<PageUi>();
    expectTypeOf<PageRunView['input']>().toEqualTypeOf<PageInput | undefined>();
  });

  it('a ProblemView is a WorkspaceProblem with an operation index', () => {
    expectTypeOf<WorkspaceProblem>().toMatchTypeOf<ProblemView>();
    expectTypeOf<ProblemView['opIndex']>().toEqualTypeOf<number | undefined>();
  });

  it('types a route call by its name', () => {
    expectTypeOf<RouteInput<'listWorkspaces'>>().toEqualTypeOf<{ params?: undefined } & { body?: undefined }>();
    expectTypeOf<RouteInput<'applyDraft'>['body']>().toEqualTypeOf<{ expectedRevision: string }>();
    expectTypeOf<RouteInput<'getPage'>['params']>().toEqualTypeOf<{ id: string; page: string }>();
    expectTypeOf<ApiClient>().toHaveProperty('streamRunEvents');
  });

  it('keeps the route table keyed by the route types', () => {
    expectTypeOf(WORKSPACE_ROUTES).toHaveProperty('streamRunEvents');
    expectTypeOf<keyof typeof WORKSPACE_ROUTES>().toEqualTypeOf<keyof WorkspaceRouteTypes>();
  });
});
