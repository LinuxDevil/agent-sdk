import { matchRoute } from '../../router/router';
import { agentTabPath } from './agentTabs';

/**
 * The agent id any agents URL names - `/agents/:id`, `/agents/:id/canvas` and
 * `/agents/:id/:tab` all carry it. `undefined` for bare `/agents` (the list)
 * and every other route.
 */
export function agentRouteId(hash: string): string | undefined {
  return matchRoute(hash, ['/agents/:id', '/agents/:id/:tab'])?.params.id;
}

/** The builder URL for an agent: always its canvas tab, including the unsaved `untitled-agent`. */
export function agentPath(agentId: string): string {
  return agentTabPath(agentId, 'canvas');
}

export type RouteSync = { kind: 'none' } | { kind: 'fallback' } | { kind: 'switch'; id: string };

/**
 * What an agents hash asks of the open document once the saved-agent list has
 * loaded: nothing when the named agent is already open (or the URL names no
 * agent), a switch to a saved agent, or a fallback to the list when the id is
 * deleted or mistyped.
 */
export function routeSyncAction(
  routeId: string | undefined,
  agentId: string,
  agents: { id: string }[],
  loaded: boolean,
): RouteSync {
  if (!loaded || routeId === undefined || routeId === agentId) return { kind: 'none' };
  // Deleted or mistyped: back to #/agents (the list) and whatever is open, no error screen.
  if (!agents.some((a) => a.id === routeId)) return { kind: 'fallback' };
  return { kind: 'switch', id: routeId };
}
