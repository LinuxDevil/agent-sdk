import { useAppState } from '../state/AppState';
import type { DrawerTab } from '../state/AppState';

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'logs', label: 'Logs' },
  { id: 'trace', label: 'Trace' },
  { id: 'output', label: 'Output' },
  { id: 'settings', label: 'Settings' },
];

/**
 * Tab-switching chrome only - each tab's real content is a later epic:
 * Chat -> LOU-P, Logs/Trace -> LOU-O, Settings -> LOU-R. "Output" shows the
 * current in-memory `AgentSpec` as JSON, which is real (LOU-L2 data), not a
 * placeholder.
 */
export function BottomDrawer() {
  const { drawerTab, setDrawerTab, spec } = useAppState();

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
      <div className="drawer-body">
        {drawerTab === 'chat' && <div>Chat with a running agent is wired up in LOU-P.</div>}
        {drawerTab === 'logs' && <div>Live execution logs are wired up in LOU-O (debug console).</div>}
        {drawerTab === 'trace' && <div>Execution trace spans are wired up in LOU-O (debug console).</div>}
        {drawerTab === 'output' && <pre style={{ margin: 0 }}>{JSON.stringify(spec, null, 2)}</pre>}
        {drawerTab === 'settings' && <div>Provider keys and deploy target settings are wired up in LOU-R.</div>}
      </div>
    </div>
  );
}
