/**
 * The observed-agent page's path helper (W07b): `#/observed/<agent_id>`.
 * `agentId` is a daemon `agent_id` (a UUID) - encoded so any id round-trips.
 */
export function observedAgentPath(agentId: string): string {
  return `/observed/${encodeURIComponent(agentId)}`;
}
