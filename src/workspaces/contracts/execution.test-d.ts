import { describe, it, expectTypeOf } from 'vitest';
import type { PageExecutionLimits, WorkType } from './page';
import type { PageEngine, PageRunContext, PageRunEvent, PageStepLabels, StepKind } from './execution';

describe('execution contract types', () => {
  it('an engine that returns a missing status does not compile', () => {
    const engine: PageEngine = {
      type: 'single',
      // @ts-expect-error status is required on PageResult
      run: async () => ({ artifacts: [], summary: 'done', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, runId: 'r1' }),
    };
    expectTypeOf(engine.type).toEqualTypeOf<WorkType>();
  });

  it('a step event without stepKind does not compile', () => {
    // @ts-expect-error stepKind is required on a step event
    const event: PageRunEvent = { type: 'step', phase: 'start', page: 'instagram', attachment: 'writer', harnessHash: 'h', executionType: 'single', stepIndex: 0 };
    expectTypeOf(event).toMatchTypeOf<PageRunEvent>();
  });

  it('a step event carries every PageStepLabels field', () => {
    expectTypeOf<Extract<PageRunEvent, { type: 'step' }>>().toMatchTypeOf<PageStepLabels>();
    expectTypeOf<PageStepLabels['stepKind']>().toEqualTypeOf<StepKind>();
  });

  it('the run context reuses the page execution limits', () => {
    expectTypeOf<PageRunContext['limits']>().toEqualTypeOf<PageExecutionLimits>();
  });
});
