import type { Graph } from '../graph/v2/types';
import { toolNodeName } from '../graph/v2/nodeIds';
import type { ToolNodeData } from '../graph/v2/types';
import type { AgentRunStatusPayload, SpanEvent } from '../../shared/wireTypes';
import { nodeIdForSpan } from '../components/debug/nodeLookup';

/** A node card's status, in the builder's StatusPill vocabulary. */
export type NodeRunStatus = 'idle' | 'running' | 'paused' | 'done' | 'error';

function spanStatus(span: SpanEvent, runStatus: AgentRunStatusPayload | undefined): NodeRunStatus {
  if (span.endTime === undefined) {
    // An open span is live only while its run is: a stopped or finished run's never-ended span is not running.
    const run = runStatus?.status;
    return run === 'running' || run === 'paused' ? run : 'idle';
  }
  return span.status?.code === 'error' ? 'error' : 'done';
}

/** An open span outranks a failed one, which outranks a finished one. */
const RANK: Record<NodeRunStatus, number> = { idle: 0, done: 1, error: 2, paused: 3, running: 4 };

/**
 * Each node's status in the current run, from the live span feed: the node
 * of an open span is running while the run is running (paused while it is
 * paused, idle once it stopped or ended), a node whose spans
 * all ended is done (error if one failed), the tool a run is paused on for
 * approval is paused, and every other node is idle. `nodeIdMap` is the
 * graphToSpec id rekey, so a span's `lousho.node.id` lands on the current
 * node even after an in-session rename.
 */
export function nodeRunStatuses(
  graph: Graph,
  spans: SpanEvent[],
  runStatus: AgentRunStatusPayload | undefined,
  nodeIdMap: Record<string, string>
): Record<string, NodeRunStatus> {
  const statuses: Record<string, NodeRunStatus> = Object.fromEntries(graph.nodes.map((n) => [n.id, 'idle']));
  const raise = (nodeId: string | undefined, status: NodeRunStatus) => {
    if (nodeId && nodeId in statuses && RANK[status] > RANK[statuses[nodeId]]) statuses[nodeId] = status;
  };
  for (const span of spans) raise(nodeIdForSpan(graph, span, nodeIdMap), spanStatus(span, runStatus));
  const pending = runStatus?.status === 'paused' ? runStatus.pendingApproval : undefined;
  if (pending) {
    const tool = graph.nodes.find((n) => n.kind === 'tool' && toolNodeName((n.data as ToolNodeData).item) === pending.toolName);
    raise(tool?.id, 'paused');
  }
  return statuses;
}
