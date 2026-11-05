/**
 * `KindRules` for `agent` nodes. `connectFrom` is the default attach
 * effect: drawing agent → capability re-owns the capability to that agent.
 * `validate` arrives with the agent inspector (C03), `duplicateData` with
 * the subagent group ticket (C04).
 */
import type { ConnectResult, KindRules } from '../kindRules';
import { reownNode } from '../reown';
import type { GraphNode, Graph } from '../types';

/** `KindRules` for `agent`: `connectFrom` re-owns the target to the source agent. */
export const agentRules: KindRules<'agent'> = {
  connectFrom: (source, target: GraphNode, graph: Graph): ConnectResult => ({
    ok: true,
    graph: reownNode(graph, target.id, source.id),
  }),
};
