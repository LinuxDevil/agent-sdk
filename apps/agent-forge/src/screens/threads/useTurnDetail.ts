/**
 * A thread turn's full root input/output. The session detail only carries
 * 200-char previews, so each turn lazily fetches its own trace detail once it
 * nears the viewport (a 500-turn thread doesn't fire 500 requests at once).
 */
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { nestObservations } from '../../observe/tree';
import type { ObserveTraceDetail, ObserveTraceRow } from '../../observe/types';
import { useTraceDetail, type ObserveQuery } from '../../observe/useObserve';

/** How far outside the viewport a turn starts fetching. */
const NEAR_MARGIN = '600px 0px';

/**
 * True once `ref`'s element has come within `rootMargin` of the viewport, and
 * stays true. Without IntersectionObserver (jsdom, old browsers) it is true at once.
 */
export function useNearViewport(ref: RefObject<Element | null>, rootMargin = NEAR_MARGIN): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true);
    }, { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [near, ref, rootMargin]);
  return near;
}

/** What a turn renders: the full root I/O, or the trace row's previews while that is unavailable. */
export interface TurnIO {
  input: string | null;
  output: string | null;
  /** `full`: the root's I/O as stored; `preview`: the 200-char previews (loading, failed or missing detail). */
  source: 'full' | 'preview';
  /** The recorder truncated the root's stored I/O. */
  truncated: boolean;
}

function turnIO(trace: ObserveTraceRow, detail: ObserveTraceDetail | undefined): TurnIO {
  const root = detail ? nestObservations(detail.observations)[0]?.row : undefined;
  if (!root) return { input: trace.input_preview, output: trace.output_preview, source: 'preview', truncated: false };
  return { input: root.input, output: root.output, source: 'full', truncated: root.truncated };
}

/** The turn's trace-detail query (fetched once `near`) and the I/O to render from it. */
export function useTurnDetail(trace: ObserveTraceRow, near: boolean): { query: ObserveQuery<ObserveTraceDetail | undefined>; io: TurnIO } {
  const query = useTraceDetail(near ? trace.trace_id : undefined);
  const io = useMemo(() => turnIO(trace, query.data), [trace, query.data]);
  return { query, io };
}
