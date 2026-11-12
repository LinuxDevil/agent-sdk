import { useAppState } from '../../state/AppState';
import { usePendingDraftCount } from '../../state/usePendingDraftCount';
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
  const saved = agents.some((a) => a.id === agentId);
  // The Suggestions tab's pending-draft badge (L11b); an unsaved agent has none.
  const draftCount = usePendingDraftCount(saved ? agentId : undefined);
  if (!saved) return null;
  return (
    <div className="builder-tabs">
      <Tabs label="Agent" currentId="canvas" items={agentTabItems(agentId, { suggestions: draftCount })} />
    </div>
  );
}
