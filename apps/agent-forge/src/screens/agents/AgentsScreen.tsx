import { useEffect, useState } from 'react';
import { Topbar, type SidePanel } from '../../components/Topbar';
import { LeftRail } from '../../components/LeftRail';
import { CanvasArea } from '../../components/CanvasArea';
import { Inspector } from '../../components/Inspector';
import { BottomDrawer } from '../../components/BottomDrawer';
import { NARROW_QUERY, useMediaQuery } from '../../components/useMediaQuery';
import { useShell } from '../../shell/AppShell';
import { useAppState } from '../../state/AppState';
import { useAgentRouteSync } from './useAgentRouteSync';
import { useInspectorCollapsed } from './useInspectorCollapsed';

/**
 * Below 860px the rail and the Inspector are slide-over drawers,
 * opened one at a time from the top bar and closed by Escape or the scrim.
 */
function useSidePanels() {
  const narrow = useMediaQuery(NARROW_QUERY);
  const [open, setOpen] = useState<SidePanel | undefined>(undefined);
  const { navOpen } = useShell();

  // One drawer at a time: opening the nav drawer closes a side panel.
  useEffect(() => {
    if (navOpen) setOpen(undefined);
  }, [navOpen]);

  useEffect(() => {
    if (!narrow) setOpen(undefined);
  }, [narrow]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(undefined);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const toggle = (panel: SidePanel) => setOpen((current) => (current === panel ? undefined : panel));
  return { narrow, open, toggle, close: () => setOpen(undefined) };
}

/**
 * `#/agents` and `#/agents/:id` - the builder: agent rail, canvas, Inspector and the run drawer,
 * under the Build toolbar. The hash names the open agent (see `useAgentRouteSync`).
 * The docked Inspector collapses while nothing is selected (`useInspectorCollapsed`).
 */
export function AgentsScreen() {
  useAgentRouteSync();
  const panels = useSidePanels();
  const inspector = useInspectorCollapsed(useAppState().selectedNodeId);
  const shellClass = `shell${panels.open ? ` ${panels.open}-open` : ''}${inspector.collapsed ? ' inspector-collapsed' : ''}`;
  return (
    <div className="app">
      <h1 className="visually-hidden">Agent Forge</h1>
      <Topbar narrow={panels.narrow} openPanel={panels.open} onTogglePanel={panels.toggle} />
      <div className={shellClass}>
        <LeftRail />
        <CanvasArea inspectorCollapsed={inspector.collapsed} onToggleInspector={inspector.toggle} />
        <Inspector />
        {panels.open && <div className="shell-scrim" aria-hidden="true" onClick={panels.close} />}
      </div>
      <BottomDrawer />
    </div>
  );
}
