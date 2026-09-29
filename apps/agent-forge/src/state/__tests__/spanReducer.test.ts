import { describe, it, expect } from 'vitest';
import { upsertSpan, orderSpansForWaterfall } from '../spanReducer';
import type { SpanEvent } from '../../runtime/runtimeClient';

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

describe('orderSpansForWaterfall', () => {
  it('orders root spans first, each followed depth-first by its children', () => {
    const spans: SpanEvent[] = [
      span({ id: 'tool', name: 'tool.call', parentId: 'root', startTime: 20 }),
      span({ id: 'llm', name: 'llm.generate', parentId: 'root', startTime: 10 }),
      span({ id: 'root', name: 'agent.run', startTime: 0 }),
    ];
    const ordered = orderSpansForWaterfall(spans);
    expect(ordered.map((s) => s.id)).toEqual(['root', 'llm', 'tool']);
  });

  it('sorts siblings by start time', () => {
    const spans: SpanEvent[] = [
      span({ id: 'b', parentId: 'root', startTime: 20 }),
      span({ id: 'a', parentId: 'root', startTime: 10 }),
      span({ id: 'root', startTime: 0 }),
    ];
    expect(orderSpansForWaterfall(spans).map((s) => s.id)).toEqual(['root', 'a', 'b']);
  });
});
