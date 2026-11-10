import { useAppState } from '../../state/AppState';
import { Tabs } from '../../ui/Tabs';
import { agentTabItems } from './agentTabs';
import './builderTabs.css';

/**
 * The agent tabs above the builder toolbar (A12): the same strip the detail
 * header shows, with Canvas current, so every tab is one click from the
 * canvas. Renders nothing while the open agent is not a saved one (the
 * unsaved `untitled-agent` default has no tabs to switch between).
 */
export function BuilderTabs(): JSX.Element | null {
  const { agentId, agents } = useAppState();
  if (!agents.some((a) => a.id === agentId)) return null;
  return (
    <div className="builder-tabs">
      <Tabs label="Agent" currentId="canvas" items={agentTabItems(agentId)} />
    </div>
  );
}
