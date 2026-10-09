/** Eve CORE-F14: `finishReason` is a closed union, so a typo does not compile. */
import { describe, it, expectTypeOf } from 'vitest';
import type { ExecutionFinishReason, ExecutionResult } from './AgentExecutor';

declare const result: ExecutionResult;

describe('ExecutionFinishReason', () => {
  it('is exactly the known reasons', () => {
    expectTypeOf<ExecutionFinishReason>().toEqualTypeOf<
      | 'stop'
      | 'length'
      | 'tool_calls'
      | 'content_filter'
      | 'error'
      | 'other'
      | 'awaiting-approval'
      | 'aborted'
      | 'max-steps'
      | 'output-invalid'
      | 'budget-exceeded'
      | 'guardrail'
    >();
  });

  it('rejects a typo', () => {
    // @ts-expect-error - 'max_steps' is not a finish reason ('max-steps' is)
    const typo: ExecutionFinishReason = 'max_steps';
    void typo;
    // @ts-expect-error - the comparison has no overlap
    void (result.finishReason === 'max_steps');
  });
});
