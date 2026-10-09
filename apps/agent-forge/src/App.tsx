import './components/layout.css';
import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { AppStateProvider } from './state/AppState';
import { Topbar, type SidePanel } from './components/Topbar';
import { LeftRail } from './components/LeftRail';
import { CanvasArea } from './components/CanvasArea';
import { Inspector } from './components/Inspector';
import { BottomDrawer } from './components/BottomDrawer';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NARROW_QUERY, useMediaQuery } from './components/useMediaQuery';

/**
 * Eve DUI-F8: below 860px the rail and the Inspector are slide-over drawers,
 * opened one at a time from the top bar and closed by Escape or the scrim.
 */
function useSidePanels() {
  const narrow = useMediaQuery(NARROW_QUERY);
  const [open, setOpen] = useState<SidePanel | undefined>(undefined);

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

function Studio() {
  const panels = useSidePanels();
  const shellClass = `shell${panels.open ? ` ${panels.open}-open` : ''}`;
  return (
    <div className="app">
      <h1 className="visually-hidden">Agent Forge</h1>
      <Topbar narrow={panels.narrow} openPanel={panels.open} onTogglePanel={panels.toggle} />
      <div className={shellClass}>
        <LeftRail />
        <CanvasArea />
        <Inspector />
        {panels.open && <div className="shell-scrim" aria-hidden="true" onClick={panels.close} />}
      </div>
      <BottomDrawer />
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <AppStateProvider>
        {/* Eve DUI-F9: shared by the canvas and the rail's palette (click/keyboard add at the viewport centre). */}
        <ReactFlowProvider>
          <Studio />
        </ReactFlowProvider>
      </AppStateProvider>
    </ErrorBoundary>
  );
}
