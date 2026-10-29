import { useCallback, useState } from 'react';
import { readStored, writeStored } from '../../components/storedValue';

/** localStorage key for the viewer's explicit Show/Hide inspector choice: "1" hidden, "0" shown. */
export const INSPECTOR_COLLAPSED_KEY = 'forge.inspector.collapsed';

/** The viewer's explicit choice, or collapsed when they never made one. */
function collapsedWithNothingSelected(): boolean {
  return readStored(INSPECTOR_COLLAPSED_KEY) !== '0';
}

/**
 * Whether the docked Inspector column is collapsed (wide layout only; below
 * 860px it is a drawer the top bar opens). With nothing selected it is
 * collapsed - so the canvas gets the width to show the whole graph legibly -
 * unless the viewer pressed Show inspector, which is remembered. Selecting a
 * node always opens it, as before; deselecting returns to the remembered
 * choice. `toggle` is the explicit Show/Hide, and the only thing stored.
 *
 * Derived during render (no effect), so the Inspector opens in the same paint
 * as the selection that opens it.
 */
export function useInspectorCollapsed(selectedNodeId: string | undefined): { collapsed: boolean; toggle: () => void } {
  const [whenEmpty, setWhenEmpty] = useState(collapsedWithNothingSelected);
  // Hide pressed over the current selection: hidden until the selection changes.
  const [hiddenOverSelection, setHiddenOverSelection] = useState(false);
  const [seenSelection, setSeenSelection] = useState(selectedNodeId);
  if (seenSelection !== selectedNodeId) {
    // React's "adjust state when a prop changes" pattern: re-renders before paint, no effect.
    setSeenSelection(selectedNodeId);
    setHiddenOverSelection(false);
  }
  const collapsed = selectedNodeId ? hiddenOverSelection && seenSelection === selectedNodeId : whenEmpty;

  const toggle = useCallback(() => {
    const next = !collapsed;
    writeStored(INSPECTOR_COLLAPSED_KEY, next ? '1' : '0');
    setWhenEmpty(next);
    setHiddenOverSelection(next);
  }, [collapsed]);

  return { collapsed, toggle };
}
