import { describe, expect, it } from 'vitest';
import { stepForToolSpan } from '../forkFromSpan';
import type { RunHistoryStep, SpanEvent } from '../../../../shared/wireTypes';

// Two checkpointed steps; step 2 produced `call_2`.
const STEPS: RunHistoryStep[] = [
  {
    step: 1,
    status: 'in-progress',
    savedAt: '2026-10-01T10:00:00.000Z',
    toolCalls: [{ id: 'call_1', name: 'get_weather', args: '{}' }],
  },
  {
    step: 2,
    status: 'in-progress',
    savedAt: '2026-10-01T10:00:01.000Z',
    toolCalls: [
      { id: 'call_2', name: 'get_time', args: '{}' },
      { id: 'call_3', name: 'get_news', args: '{}' },
    ],
  },
];

function span(attributes: Record<string, unknown>): SpanEvent {
  return { id: 's1', name: 'execute_tool', startTime: 1, attributes };
}

describe('stepForToolSpan', () => {
  it('returns the step whose toolCalls include the span’s gen_ai.tool.call.id', () => {
    expect(stepForToolSpan(STEPS, span({ 'gen_ai.tool.call.id': 'call_2' }))).toBe(STEPS[1]);
    expect(stepForToolSpan(STEPS, span({ 'gen_ai.tool.call.id': 'call_1' }))).toBe(STEPS[0]);
  });

  it('returns undefined when no step’s toolCalls include the call id', () => {
    expect(stepForToolSpan(STEPS, span({ 'gen_ai.tool.call.id': 'call_9' }))).toBeUndefined();
    expect(stepForToolSpan([], span({ 'gen_ai.tool.call.id': 'call_1' }))).toBeUndefined();
  });

  it('returns undefined when the span has no call id (or a non-string one)', () => {
    expect(stepForToolSpan(STEPS, span({}))).toBeUndefined();
    expect(stepForToolSpan(STEPS, span({ 'gen_ai.tool.call.id': 42 }))).toBeUndefined();
    expect(stepForToolSpan(STEPS, span({ 'gen_ai.tool.call.id': '' }))).toBeUndefined();
  });
});
