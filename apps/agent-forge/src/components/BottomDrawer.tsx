import type { CSSProperties, ReactElement } from 'react';
import { useAppState } from '../state/AppState';
import type { DrawerTab } from '../state/AppState';
import { LogsPanel } from './debug/LogsPanel';
import { TracePanel } from './debug/TracePanel';
import { OutputPanel } from './debug/OutputPanel';
import { DebugBar } from './debug/DebugBar';
import { ChatPanel } from './ChatPanel';
import { SettingsPanel } from './SettingsPanel';

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'logs', label: 'Logs' },
  { id: 'trace', label: 'Trace' },
  { id: 'output', label: 'Output' },
  { id: 'settings', label: 'Settings' },
];

const TAB_PANELS: Record<DrawerTab, () => ReactElement> = {
  chat: () => <ChatPanel />,
  logs: () => <LogsPanel />,
  trace: () => <TracePanel />,
  output: () => <OutputPanel />,
  settings: () => <SettingsPanel />,
};

// Every tab except Output manages its own padding/scrolling.
const FLUSH_TABS: ReadonlySet<DrawerTab> = new Set<DrawerTab>(['logs', 'trace', 'chat', 'settings']);
const FLUSH_BODY_STYLE: CSSProperties = { padding: 0, overflow: 'hidden' };

/**
 * Tab-switching chrome (LOU-L), now with real content for LOU-O's
 * Logs/Trace/Output tabs: `LogsPanel` (O1, a live filtered/virtualized log
 * feed), `TracePanel` (O2, a real span waterfall) and `OutputPanel` (O4, a
 * collapsible JSON tree of the final/paused ExecutionResult). `DebugBar`
 * (O3) surfaces above Trace whenever debug mode is on or a run is paused
 * at a breakpoint. Chat (LOU-P) and Settings (LOU-R) are still later
 * epics' jobs.
 */
export function BottomDrawer() {
  const { drawerTab, setDrawerTab } = useAppState();

  return (
    <div className="drawer">
      <div className="drawer-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`drawer-tab${drawerTab === tab.id ? ' active' : ''}`}
            onClick={() => setDrawerTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <div className="drawer-spacer" />
      </div>
      {drawerTab === 'trace' && <DebugBar />}
      <div className="drawer-body" style={FLUSH_TABS.has(drawerTab) ? FLUSH_BODY_STYLE : undefined}>
        {TAB_PANELS[drawerTab]()}
      </div>
    </div>
  );
}
