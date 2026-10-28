import { describe, it, expect } from 'vitest';
import { upsertSpan } from '../spanReducer';
import type { SpanEvent } from '../../../shared/wireTypes';

function span(overrides: Partial<SpanEvent>): SpanEvent {
  return {
    id: 'span-1',
    name: 'agent.run',
    startTime: 0,
    attributes: {},
    ...overrides,
  };
}

describe('upsertSpan', () => {
  it('appends a new span id', () => {
    const spans = upsertSpan([], span({ id: 'a' }));
    expect(spans).toHaveLength(1);
  });

  it('merges an onSpanEnd notification onto the same row an onSpanStart created, by id', () => {
    const started = [span({ id: 'a', startTime: 100 })];
    const ended = upsertSpan(started, span({ id: 'a', startTime: 100, endTime: 150 }));
    expect(ended).toHaveLength(1);
    expect(ended[0].endTime).toBe(150);
  });

  it('never mutates the input array', () => {
    const original = [span({ id: 'a' })];
    const next = upsertSpan(original, span({ id: 'a', endTime: 10 }));
    expect(original[0].endTime).toBeUndefined();
    expect(next).not.toBe(original);
  });
});
