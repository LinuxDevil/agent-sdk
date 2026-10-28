import type { AgentGraphSpec } from '../graph/types';
import type { AgentRunStatusPayload, SpanEvent } from '../../shared/wireTypes';
import { nodeIdForSpan } from '../components/debug/nodeLookup';

/** A node card's status, in the builder's StatusPill vocabulary. */
export type NodeRunStatus = 'idle' | 'running' | 'paused' | 'done' | 'error';

function spanStatus(span: SpanEvent, runStatus: AgentRunStatusPayload | undefined): NodeRunStatus {
  if (span.endTime === undefined) return runStatus?.status === 'paused' ? 'paused' : 'running';
  return span.status?.code === 'error' ? 'error' : 'done';
}

/** An open span outranks a failed one, which outranks a finished one. */
const RANK: Record<NodeRunStatus, number> = { idle: 0, done: 1, error: 2, paused: 3, running: 4 };

/**
 * Each node's status in the current run, from the live span feed: the node
 * of an open span is running (paused while the run is), a node whose spans
 * all ended is done (error if one failed), the tool a run is paused on for
 * approval is paused, and every other node is idle.
 */
export function nodeRunStatuses(
  graph: AgentGraphSpec,
  spans: SpanEvent[],
  runStatus: AgentRunStatusPayload | undefined
): Record<string, NodeRunStatus> {
  const statuses: Record<string, NodeRunStatus> = Object.fromEntries(graph.nodes.map((n) => [n.id, 'idle']));
  const raise = (nodeId: string | undefined, status: NodeRunStatus) => {
    if (nodeId && nodeId in statuses && RANK[status] > RANK[statuses[nodeId]]) statuses[nodeId] = status;
  };
  for (const span of spans) raise(nodeIdForSpan(graph, span), spanStatus(span, runStatus));
  const pending = runStatus?.status === 'paused' ? runStatus.pendingApproval : undefined;
  if (pending) {
    const tool = graph.nodes.find((n) => n.type === 'tool' && n.data.toolName === pending.toolName);
    raise(tool?.id, 'paused');
  }
  return statuses;
}
