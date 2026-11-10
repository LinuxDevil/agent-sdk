import { useCallback, useState } from 'react';

/**
 * The node spans sheet's open state (T03): which canvas node's spans
 * `NodeSpansSheet` is showing. `openNodeSpans`/`closeNodeSpans` are stable
 * (the canvas's node list memoizes on `openNodeSpans`); agent switches call
 * `closeNodeSpans` so a stale node id never survives into another agent.
 */
export function useNodeSpans(): {
  spansNodeId: string | undefined;
  openNodeSpans: (nodeId: string) => void;
  closeNodeSpans: () => void;
} {
  const [spansNodeId, setSpansNodeId] = useState<string | undefined>(undefined);
  const openNodeSpans = useCallback((nodeId: string) => setSpansNodeId(nodeId), []);
  const closeNodeSpans = useCallback(() => setSpansNodeId(undefined), []);
  return { spansNodeId, openNodeSpans, closeNodeSpans };
}
