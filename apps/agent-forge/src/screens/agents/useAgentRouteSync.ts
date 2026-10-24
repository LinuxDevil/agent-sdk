import { useEffect, useRef } from 'react';
import { navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useAppState } from '../../state/AppState';
import { agentPath, agentRouteId, routeSyncAction } from './agentRoute';
import { confirmDiscardChanges } from './unsavedChanges';

/**
 * Keeps `#/agents/:id` and the open agent in step. The hash drives selection
 * (rail clicks push `#/agents/:id`, back/forward and reload land here), asking
 * first when the open agent has unsaved changes - cancelling restores the
 * hash. When the open agent changes under the URL (create, rename, delete),
 * the hash follows with replace. The initial load leaves the URL as it is.
 */
export function useAgentRouteSync(): void {
  const { agentId, agents, agentsLoaded, dirty, switchAgent } = useAppState();
  const routeId = agentRouteId(`#${useRoute().path}`);
  // Read inside the hash-driven effect without re-running it when the document changes.
  const latest = useRef({ agentId, agents, dirty, switchAgent });
  latest.current = { agentId, agents, dirty, switchAgent };

  useEffect(() => {
    const { agentId: openId, agents: saved, dirty: unsaved, switchAgent: open } = latest.current;
    const action = routeSyncAction(routeId, openId, saved, agentsLoaded);
    if (action.kind === 'fallback') navigate('/agents', { replace: true });
    if (action.kind !== 'switch') return;
    if (!confirmDiscardChanges(unsaved, openId)) {
      navigate(agentPath(openId, saved), { replace: true });
      return;
    }
    open(action.id).catch(() => navigate('/agents', { replace: true }));
  }, [routeId, agentsLoaded]);

  // The agent the URL last agreed with; `undefined` until the list has loaded.
  const synced = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!agentsLoaded) return;
    const previous = synced.current;
    synced.current = agentId;
    if (previous === undefined || previous === agentId) return;
    navigate(agentPath(agentId, latest.current.agents), { replace: true });
  }, [agentsLoaded, agentId]);
}
