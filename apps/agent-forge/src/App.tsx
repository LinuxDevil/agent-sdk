import './components/layout.css';
import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { AppStateProvider, useAppState } from './state/AppState';
import { Topbar, type SidePanel } from './components/Topbar';
import { LeftRail } from './components/LeftRail';
import { CanvasArea } from './components/CanvasArea';
import { Inspector } from './components/Inspector';
import { BottomDrawer } from './components/BottomDrawer';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NARROW_QUERY, useMediaQuery } from './components/useMediaQuery';
import { ObserveView } from './observe/ObserveView';
import { AppShell, useShell } from './shell/AppShell';
import { useRoute } from './router/useRoute';

/** Until the route table lands, these hash routes show the existing observability panels. */
const OBSERVE_ROUTES = new Set(['traces', 'monitoring', 'evals']);
const isObservePath = (path: string) => OBSERVE_ROUTES.has(path.split('/')[1] ?? '');

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

function Studio() {
  const panels = useSidePanels();
  const { setView } = useAppState();
  const { path } = useRoute();
  const observePath = isObservePath(path);
  // Keeps the (still-present) Build/Observe state in step with the route; the route decides what renders.
  useEffect(() => {
    setView(observePath ? 'observe' : 'build');
  }, [observePath, setView]);
  const shellClass = `shell${panels.open ? ` ${panels.open}-open` : ''}`;
  // Observe mode: the daemon-backed panels take the whole content area
  // (builder rail/canvas/inspector and the run drawer are build-mode chrome).
  if (observePath) {
    return (
      <div className="app app-observe">
        <h1 className="visually-hidden">Agent Forge</h1>
        <Topbar narrow={panels.narrow} openPanel={panels.open} onTogglePanel={panels.toggle} />
        <ObserveView />
      </div>
    );
  }
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
        {/* Shared by the canvas and the rail's palette (click/keyboard add at the viewport centre). */}
        <ReactFlowProvider>
          <AppShell>
            <Studio />
          </AppShell>
        </ReactFlowProvider>
      </AppStateProvider>
    </ErrorBoundary>
  );
}
