import { useEffect, useRef } from 'react';
import { navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useAppState } from '../../state/AppState';
import { useToast } from '../../ui/Toast';
import { agentListPath } from './agentTabs';
import { agentPath, agentRouteId, routeSyncAction } from './agentRoute';
import { activeWorkspace } from '../../workspace/activeWorkspace';
import { confirmDiscardChanges } from './unsavedChanges';

/**
 * Keeps the agents URL and the open agent in step. The hash drives
 * selection (rail clicks push the tab URL, back/forward and reload land
 * here), asking first when the open agent has unsaved changes - cancelling
 * restores the hash. When the open agent changes under the URL (create,
 * rename, delete), the hash follows with replace. An unknown id falls back
 * to the workspace's agent list.
 *
 * W04b: the saved-agent list belongs to one workspace (`agentsWorkspaceId`);
 * while it is not the URL's workspace the sync waits - judging `#/w/<B>/…`
 * against workspace A's list would switch to the wrong agent or fall back
 * spuriously. `AppStateProvider` refetches the list on every workspace
 * change, and the `agentsWorkspaceId` dep re-runs this effect once it lands.
 */
export function useAgentRouteSync(): void {
  const { agentId, agents, agentsLoaded, agentsWorkspaceId, dirty, switchAgent } = useAppState();
  const hash = `#${useRoute().path}`;
  const routeId = agentRouteId(hash);
  const toast = useToast();
  // Read inside the hash-driven effect without re-running it when the document changes.
  const latest = useRef({ agentId, agents, dirty, switchAgent, toast });
  latest.current = { agentId, agents, dirty, switchAgent, toast };

  useEffect(() => {
    if (agentsWorkspaceId !== undefined && agentsWorkspaceId !== activeWorkspace()) return;
    const { agentId: openId, agents: saved, dirty: unsaved, switchAgent: open, toast: notify } = latest.current;
    const action = routeSyncAction(routeId, openId, saved, agentsLoaded);
    if (action.kind === 'fallback') {
      navigate(agentListPath(activeWorkspace()), { replace: true });
      return;
    }
    if (action.kind !== 'switch') return;
    if (!confirmDiscardChanges(unsaved, openId)) {
      navigate(agentPath(openId), { replace: true });
      return;
    }
    open(action.id).catch((err: unknown) => {
      notify.show({ tone: 'error', message: `Could not open agent ${action.id}: ${err instanceof Error ? err.message : String(err)}` });
      navigate(agentListPath(activeWorkspace()), { replace: true });
    });
  }, [routeId, agentsLoaded, agentsWorkspaceId]);

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
