import { matchRoute } from '../../router/router';

/** What the builder opens when nothing is saved yet; it has no file, so its URL is bare `#/agents`. */
const UNSAVED_AGENT_ID = 'untitled-agent';

/** The agent id `#/agents/:id` names, or `undefined` for bare `#/agents` and every other route. */
export function agentRouteId(hash: string): string | undefined {
  return matchRoute(hash, ['/agents/:id'])?.params.id;
}

/** The hash path that shows `agentId`: `#/agents/:id`, or bare `#/agents` for the unsaved default. */
export function agentPath(agentId: string, agents: { id: string }[]): string {
  const unsaved = agentId === UNSAVED_AGENT_ID && !agents.some((a) => a.id === agentId);
  return unsaved ? '/agents' : `/agents/${encodeURIComponent(agentId)}`;
}

export type RouteSync = { kind: 'none' } | { kind: 'fallback' } | { kind: 'switch'; id: string };

/** What a `#/agents/:id` hash asks of the open document once the saved-agent list has loaded. */
export function routeSyncAction(
  routeId: string | undefined,
  agentId: string,
  agents: { id: string }[],
  loaded: boolean,
): RouteSync {
  if (routeId === undefined || !loaded || routeId === agentId) return { kind: 'none' };
  // Deleted or mistyped: back to bare #/agents and whatever is open, no error screen.
  if (!agents.some((a) => a.id === routeId)) return { kind: 'fallback' };
  return { kind: 'switch', id: routeId };
}
