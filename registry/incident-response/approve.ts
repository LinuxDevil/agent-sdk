import type { ApproveToolCall } from '@lousho/build-ai-agent';

/**
 * The kit's approver (pointed at by `agent.json`'s `approve`): what reaches
 * this function is the 'ask' tier of the permission rules - production
 * remediation and anything the rules did not list.
 *
 *   tier 2 - reversible production remediation (restart, bounded scale):
 *            auto-approved, and the approval is annotated with its tier so the
 *            decision record carries why it was allowed through.
 *   tier 3 - anything hotter (scaling a service to zero, tools outside the
 *            remediation set): refused, so the call escalates to a human
 *            instead of running on the agent's own authority.
 */
const TIER_2 = new Set(['restart_service', 'scale_replicas']);

const approve: ApproveToolCall = ({ toolName, args }) => {
  const environment = String(args.environment ?? 'production');
  if (toolName === 'scale_replicas' && Number(args.replicas) === 0) {
    return false; // scaling to zero is an outage, not a remediation - tier 3
  }
  if (!TIER_2.has(toolName)) {
    return false; // outside the remediation set - tier 3, a human decides
  }
  return `approved at risk tier 2: '${toolName}' on ${environment} is reversible - verify within the incident window`;
};

export default approve;
