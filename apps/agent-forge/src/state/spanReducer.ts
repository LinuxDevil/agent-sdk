import type { SpanEvent } from '../../shared/wireTypes';

/**
 * Folds a stream of `{type:'span'}` WS messages (one per
 * onSpanStart/onSpanEnd notification - see server/runRegistry.ts's
 * `makeTraceExporter()`) into a flat list of spans, upserting by `id` so
 * the 'end' notification (which carries `endTime`) merges onto the same
 * row the 'start' notification created rather than appending a duplicate.
 */
export function upsertSpan(spans: SpanEvent[], span: SpanEvent): SpanEvent[] {
  const idx = spans.findIndex((s) => s.id === span.id);
  if (idx === -1) return [...spans, span];
  const next = spans.slice();
  next[idx] = { ...spans[idx], ...span };
  return next;
}
