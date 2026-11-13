import { useEffect, useRef } from 'react';
import { navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useAppState } from '../../state/AppState';
import { useToast } from '../../ui/Toast';
import { agentPath, agentRouteId, routeSyncAction } from './agentRoute';
import { confirmDiscardChanges } from './unsavedChanges';

/**
 * Keeps `#/agents/:id/<tab>` and the open agent in step. The hash drives
 * selection (rail clicks push the tab URL, back/forward and reload land
 * here), asking first when the open agent has unsaved changes - cancelling
 * restores the hash. When the open agent changes under the URL (create,
 * rename, delete), the hash follows with replace. An unknown id falls back
 * to `#/agents` (the list).
 */
export function useAgentRouteSync(): void {
  const { agentId, agents, agentsLoaded, dirty, switchAgent } = useAppState();
  const hash = `#${useRoute().path}`;
  const routeId = agentRouteId(hash);
  const toast = useToast();
  // Read inside the hash-driven effect without re-running it when the document changes.
  const latest = useRef({ agentId, agents, dirty, switchAgent, toast });
  latest.current = { agentId, agents, dirty, switchAgent, toast };

  useEffect(() => {
    const { agentId: openId, dirty: unsaved, switchAgent: open, toast: notify } = latest.current;
    // `agents` is a dep (not only read through `latest`): a list refresh that
    // lands after the hash changed - an Author Apply's agent.changed event is
    // debounced - must re-run the sync, or a just-created agent's deep link
    // falls back against the stale list and never retries.
    const action = routeSyncAction(routeId, openId, agents, agentsLoaded);
    if (action.kind === 'fallback') {
      navigate('/agents', { replace: true });
      return;
    }
    if (action.kind !== 'switch') return;
    if (!confirmDiscardChanges(unsaved, openId)) {
      navigate(agentPath(openId), { replace: true });
      return;
    }
    open(action.id).catch((err: unknown) => {
      notify.show({ tone: 'error', message: `Could not open agent ${action.id}: ${err instanceof Error ? err.message : String(err)}` });
      navigate('/agents', { replace: true });
    });
  }, [routeId, agentsLoaded, agents]);

  // The agent the URL last agreed with; `undefined` until the list has loaded.
  const synced = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!agentsLoaded) return;
    const previous = synced.current;
    synced.current = agentId;
    if (previous === undefined || previous === agentId) return;
    navigate(agentPath(agentId), { replace: true });
  }, [agentsLoaded, agentId]);
}
