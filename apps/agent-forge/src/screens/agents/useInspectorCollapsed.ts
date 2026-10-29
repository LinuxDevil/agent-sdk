import { useCallback, useEffect, useState } from 'react';
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
 */
export function useInspectorCollapsed(selectedNodeId: string | undefined): { collapsed: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState(() => !selectedNodeId && collapsedWithNothingSelected());

  useEffect(() => {
    setCollapsed(!selectedNodeId && collapsedWithNothingSelected());
  }, [selectedNodeId]);

  const toggle = useCallback(() => {
    setCollapsed((was) => {
      writeStored(INSPECTOR_COLLAPSED_KEY, was ? '0' : '1');
      return !was;
    });
  }, []);

  return { collapsed, toggle };
}
