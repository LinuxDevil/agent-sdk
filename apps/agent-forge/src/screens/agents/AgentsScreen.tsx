import { useCallback, useEffect, useState } from 'react';
import { Topbar, type SidePanel } from '../../components/Topbar';
import { LeftRail } from '../../components/LeftRail';
import { CanvasArea } from '../../components/CanvasArea';
import { Inspector } from '../../components/Inspector';
import { BottomDrawer } from '../../components/BottomDrawer';
import { NodeSpansSheet } from '../../components/test/NodeSpansSheet';
import { NARROW_QUERY, useMediaQuery } from '../../components/useMediaQuery';
import { useShell } from '../../shell/AppShell';
import { useAppState } from '../../state/AppState';
import { useAgentRouteSync } from './useAgentRouteSync';
import { BuilderTabs } from './BuilderTabs';
import { useInspectorCollapsed } from './useInspectorCollapsed';
import { useSaveVersionShortcut } from './useSaveVersionShortcut';
import { useAuthorCanvasSync } from '../../author/useAuthorCanvasSync';
import { useAuthorDock } from '../../author/authorDock';
import { focusProposalCard } from '../../author/proposalFocus';

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
 * `#/agents/:id/canvas` - the builder: agent rail, canvas, Inspector and the run drawer,
 * under the Build toolbar. (The legacy `#/agents/:id` redirects here; bare `#/agents`
 * is the agents list.) The hash names the open agent (see `useAgentRouteSync`).
 * The docked Inspector collapses while nothing is selected (`useInspectorCollapsed`).
 */
export function AgentsScreen() {
  useAgentRouteSync();
  // Ctrl/Cmd+S saves a version - bound only on the builder screen.
  useSaveVersionShortcut();
  const panels = useSidePanels();
  const { agentId, agents, selectedNodeId } = useAppState();
  // AA18: the Author's open update card draws dashed nodes on this canvas;
  // the pill and dashed-node clicks open the dock on its card.
  const { overlayProposalId } = useAuthorCanvasSync(agentId);
  const { setOpen: openAuthorDock } = useAuthorDock();
  const showProposalCard = useCallback(() => {
    if (overlayProposalId === null) return;
    openAuthorDock(true);
    // The dock mounts the transcript on open; the card exists a tick later.
    window.setTimeout(() => focusProposalCard(overlayProposalId), 0);
  }, [overlayProposalId, openAuthorDock]);
  const inspector = useInspectorCollapsed(selectedNodeId);
  // The agent tab strip shows only for a saved agent (BuilderTabs renders null otherwise).
  const showBuilderTabs = agents.some((a) => a.id === agentId);
  const shellClass = `shell${panels.open ? ` ${panels.open}-open` : ''}${inspector.collapsed ? ' inspector-collapsed' : ''}`;
  return (
    <div className={`app${showBuilderTabs ? ' app-builder-tabs' : ''}`}>
      {showBuilderTabs && <BuilderTabs />}
      <h1 className="visually-hidden">Agent Forge</h1>
      <Topbar narrow={panels.narrow} openPanel={panels.open} onTogglePanel={panels.toggle} />
      <div className={shellClass}>
        <LeftRail />
        <CanvasArea
          inspectorCollapsed={inspector.collapsed}
          onToggleInspector={inspector.toggle}
          proposalId={overlayProposalId}
          onShowProposal={showProposalCard}
        />
        <Inspector />
        {panels.open && <div className="shell-scrim" aria-hidden="true" onClick={panels.close} />}
      </div>
      <BottomDrawer />
      <NodeSpansSheet />
    </div>
  );
}
