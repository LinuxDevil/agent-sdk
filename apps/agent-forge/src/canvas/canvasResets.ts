import { useCallback, useEffect, useState } from 'react';

/**
 * The one owner of the canvas's first fit: when an agent is opened and when an
 * empty canvas is filled (a template applied, or the first node dropped). Calls
 * `fit` once every node has been measured (`allMeasured`), so the fit uses real
 * card sizes, and returns `true` until that fit has landed - the canvas keeps
 * its viewport hidden meanwhile, so the graph never shows unfitted and then jumps.
 */
export function useFitOnLoad(agentId: string, nodeCount: number, allMeasured: boolean, fit: () => void): boolean {
  const filled = nodeCount > 0;
  const loadKey = `${agentId}|${filled ? 'filled' : 'empty'}`;
  const [fittedKey, setFittedKey] = useState<string | null>(null);
  // An emptied graph forgets its fit, so filling it again (a template applied) refits.
  if (!filled && fittedKey !== null) setFittedKey(null);
  useEffect(() => {
    if (fittedKey === loadKey || !filled || !allMeasured) return;
    const frame = window.requestAnimationFrame(() => {
      fit();
      setFittedKey(loadKey);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadKey, fittedKey, filled, allMeasured, fit]);
  return filled && fittedKey !== loadKey;
}

/**
 * The canvas's selected edge id (drawn in the accent colour) and its setter.
 * A selection belongs to the agent it was made in: opening another agent clears it.
 */
export function useAgentEdgeSelection(agentId: string): [string | undefined, (id: string | undefined) => void] {
  const [selection, setSelection] = useState<{ agentId: string; edgeId: string | undefined }>({ agentId, edgeId: undefined });
  if (selection.agentId !== agentId) setSelection({ agentId, edgeId: undefined });
  const select = useCallback((edgeId: string | undefined) => setSelection({ agentId, edgeId }), [agentId]);
  return [selection.agentId === agentId ? selection.edgeId : undefined, select];
}
