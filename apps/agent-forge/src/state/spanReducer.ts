import type { SpanEvent } from '../runtime/runtimeClient';

/**
 * O2: folds a stream of `{type:'span'}` WS messages (one per
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

/** Root spans first, each followed depth-first by its children, sorted by start time within a level - a stable waterfall row order. */
export function orderSpansForWaterfall(spans: SpanEvent[]): SpanEvent[] {
  const byParent = new Map<string | undefined, SpanEvent[]>();
  for (const span of spans) {
    const list = byParent.get(span.parentId) ?? [];
    list.push(span);
    byParent.set(span.parentId, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.startTime - b.startTime);

  const ordered: SpanEvent[] = [];
  function visit(parentId: string | undefined) {
    for (const span of byParent.get(parentId) ?? []) {
      ordered.push(span);
      visit(span.id);
    }
  }
  visit(undefined);
  return ordered;
}
