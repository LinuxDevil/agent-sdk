/**
 * Which node-kind pairs may be connected by an edge, plus the instance-level
 * rules that refine the kind table (self-connect, root-only targets, attach
 * edges that already exist, same-agent permission scopes). Used by
 * CanvasArea's `isValidConnection` and by `connectNodes` (C23) so a drag the
 * UI lets through and a mutation the model requests are refused by the same
 * rules with the same reasons.
 */
import { ROOT_AGENT_ID } from './types';
import type { GraphNode, NodeKind } from './types';

/** Target kinds each source kind may connect to. */
export const CONNECTION_RULES: Record<NodeKind, readonly NodeKind[]> = {
  trigger: ['agent', 'abort'],
  agent: ['tool', 'mcp', 'skill', 'memory', 'subagent', 'handoff', 'guardrail', 'permission', 'hook', 'output', 'flow'],
  tool: ['permission'],
  mcp: ['permission'],
  flow: ['flow'],
  subagent: [], handoff: [], skill: [], memory: [], guardrail: [], permission: [], hook: [], output: [], abort: [], note: [],
};

/** The result of a connection check: ok, or refused with a user-facing reason. */
export type ConnectCheck = { ok: true } | { ok: false; reason: string };

/**
 * One instance-level refusal: `test` says whether the rule fires, `reason` is
 * the refusal message. Rules run in order — the first that fires wins, so
 * broader rules (self-connect, the kind table) precede the specific ones.
 */
interface ConnectRule {
  test(source: GraphNode, target: GraphNode): boolean;
  reason(source: GraphNode, target: GraphNode): string;
}

const INSTANCE_RULES: readonly ConnectRule[] = [
  {
    test: (source, target) => source.id === target.id,
    reason: () => "Can't connect a node to itself",
  },
  {
    test: (source, target) => !CONNECTION_RULES[source.kind].includes(target.kind),
    reason: (source, target) => `Can't connect ${source.kind} → ${target.kind}`,
  },
  {
    test: (source, target) =>
      source.kind === 'trigger' && target.kind === 'agent' && target.id !== ROOT_AGENT_ID,
    reason: () => 'Triggers start the main agent only',
  },
  {
    // A trigger's `starts` edge to the root agent is derived, so connecting
    // one by hand would only duplicate it.
    test: (source, target) => source.kind === 'trigger' && target.kind === 'agent',
    reason: () => 'Triggers always start the main agent',
  },
  {
    test: (source, target) =>
      source.kind === 'agent' && target.kind === 'flow' && source.id !== ROOT_AGENT_ID,
    reason: () => 'Only the main agent runs a flow',
  },
  {
    test: (source, target) => source.kind === 'agent' && target.owner === source.id,
    reason: () => 'Already attached to this agent',
  },
  {
    // Only reachable when the output node is owned by another agent — an
    // agent's own output is refused by the attach rule above — because a
    // spec carries at most one `output` per agent.
    test: (source, target) => source.kind === 'agent' && target.kind === 'output',
    reason: () => 'This agent already has an output schema',
  },
  {
    test: (source, target) =>
      (source.kind === 'tool' || source.kind === 'mcp') &&
      target.kind === 'permission' &&
      source.owner !== target.owner,
    reason: () => 'A rule only governs tools of the same agent',
  },
];

/** Kind table plus the instance rules: ok, or the first refusal reason. */
export function canConnect(source: GraphNode, target: GraphNode): ConnectCheck {
  const refused = INSTANCE_RULES.find((rule) => rule.test(source, target));
  return refused ? { ok: false, reason: refused.reason(source, target) } : { ok: true };
}
