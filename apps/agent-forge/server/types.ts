/**
 * LOU-N runtime control server - agent id validation. The wire types live
 * in ../shared/wireTypes.ts (shared with the browser client).
 */

/**
 * Every `:id`/agentId this server touches ends up interpolated into a
 * filesystem path (`.loushy/agents/<id>.yaml`, `.loushy/agents/<id>/checkpoints/**`,
 * `.loushy/agents/<id>/approvals/**` - see fsAgentStore.ts, checkpointStore.ts,
 * approvalStore.ts) with no further sanitization there. Express route
 * params are URL-decoded before `req.params.id` is populated, so a
 * percent-encoded `..%2F..%2Fsomewhere` arrives as a plain string containing
 * `/` and `..` segments - path.join() will happily walk it outside
 * `.loushy/agents/`. Restrict every accepted id up front (here, and in
 * wsServer.ts's WS upgrade handler, which parses `:id` itself rather than
 * going through Express routing) to a safe, single-path-segment token
 * instead of trying to sanitize/escape it later in each store.
 */
const AGENT_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;

export function isValidAgentId(id: string): boolean {
  return typeof id === 'string' && AGENT_ID_RE.test(id) && !id.includes('..');
}
