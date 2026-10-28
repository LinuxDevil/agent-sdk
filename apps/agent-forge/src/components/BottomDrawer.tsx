import type { CSSProperties, ReactElement } from 'react';
import { useAppState } from '../state/AppState';
import type { DrawerTab } from '../state/AppState';
import { LogsPanel } from './debug/LogsPanel';
import { TracePanel } from './debug/TracePanel';
import { OutputPanel } from './debug/OutputPanel';
import { HistoryPanel } from './debug/HistoryPanel';
import { DebugBar } from './debug/DebugBar';
import { ChatPanel } from './ChatPanel';
import { SettingsPanel } from './SettingsPanel';
import { tabIds, tabListKeyDown } from './tabs';
import { DrawerResizeHandle, useDrawerHeight } from './drawerHeight';

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'logs', label: 'Logs' },
  { id: 'trace', label: 'Trace' },
  { id: 'output', label: 'Output' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];
const TAB_IDS = TABS.map((t) => t.id);

const TAB_PANELS: Record<DrawerTab, () => ReactElement> = {
  chat: () => <ChatPanel />,
  logs: () => <LogsPanel />,
  trace: () => <TracePanel />,
  output: () => <OutputPanel />,
  history: () => <HistoryPanel />,
  settings: () => <SettingsPanel />,
};

// Every tab except Output and History manages its own padding/scrolling.
const FLUSH_TABS: ReadonlySet<DrawerTab> = new Set<DrawerTab>(['logs', 'trace', 'chat', 'settings']);
const FLUSH_BODY_STYLE: CSSProperties = { padding: 0, overflow: 'hidden' };

/**
 * Tab-switching chrome, now with real content for the
 * Logs/Trace/Output tabs: `LogsPanel` (a live filtered/virtualized log
 * feed), `TracePanel` (a real span waterfall) and `OutputPanel` (a
 * collapsible JSON tree of the final/paused ExecutionResult). `DebugBar`
 * surfaces above Trace whenever debug mode is on or a run is paused
 * at a breakpoint. Chat and Settings are still later
 * epics' jobs. Its top edge resizes it; the height is remembered per viewer
 * (see drawerHeight.tsx).
 */
export function BottomDrawer() {
  const { drawerTab, setDrawerTab } = useAppState();
  const ids = tabIds('drawer', drawerTab);
  const { height, setHeight } = useDrawerHeight();

  // A real WAI-ARIA tablist (roles, aria-selected, arrow keys).
  return (
    <section className="drawer" aria-label="Run panels" style={{ height }}>
      <DrawerResizeHandle height={height} onResize={setHeight} />
      <div
        className="drawer-tabs"
        role="tablist"
        aria-label="Run panels"
        onKeyDown={tabListKeyDown('drawer', TAB_IDS, drawerTab, setDrawerTab)}
      >
        {TABS.map((tab) => {
          const selected = drawerTab === tab.id;
          const { tab: tabId, panel } = tabIds('drawer', tab.id);
          return (
            <button
              key={tab.id}
              id={tabId}
              role="tab"
              aria-selected={selected}
              aria-controls={panel}
              tabIndex={selected ? 0 : -1}
              className={`drawer-tab${selected ? ' active' : ''}`}
              onClick={() => setDrawerTab(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
        <div className="drawer-spacer" />
      </div>
      {drawerTab === 'trace' && <DebugBar />}
      <div
        className="drawer-body"
        id={ids.panel}
        role="tabpanel"
        aria-labelledby={ids.tab}
        style={FLUSH_TABS.has(drawerTab) ? FLUSH_BODY_STYLE : undefined}
      >
        {TAB_PANELS[drawerTab]()}
      </div>
    </section>
  );
}
