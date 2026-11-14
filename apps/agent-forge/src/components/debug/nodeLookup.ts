import { toolNodeName } from '../../graph/v2/nodeIds';
import type { Graph, ToolNodeData } from '../../graph/v2/types';
import { ROOT_AGENT_ID } from '../../graph/v2/types';
import type { SpanEvent } from '../../../shared/wireTypes';

/**
 * Shared by the Logs and Trace panels: map a log line / span back to the
 * canvas node it describes so clicking either can highlight that node.
 */
export function findLlmNodeId(): string {
  return ROOT_AGENT_ID;
}

/** The first tool node whose `toolNodeName` matches `toolName`. */
export function findToolNodeId(graph: Graph, toolName: string | undefined): string | undefined {
  if (!toolName) return undefined;
  return graph.nodes.find((n) => n.kind === 'tool' && toolNodeName((n.data as ToolNodeData).item) === toolName)?.id;
}

/**
 * The canvas node a span describes: a `lousho.node.id` attribute wins
 * (matched through `nodeIdMap`, the graphToSpec id rekey, so a node renamed
 * mid-session still resolves); otherwise `chat` spans are the root agent
 * node and `execute_tool` spans their tool's node.
 */
export function nodeIdForSpan(graph: Graph, span: SpanEvent, nodeIdMap: Record<string, string>): string | undefined {
  const stamped = span.attributes['lousho.node.id'];
  if (typeof stamped === 'string') {
    return graph.nodes.find((n) => nodeIdMap[n.id] === stamped)?.id;
  }
  // SDK spans follow the OpenTelemetry GenAI conventions: the operation is
  // `chat` (model call) or `execute_tool` (tool call).
  const operation = span.attributes['gen_ai.operation.name'];
  if (operation === 'chat') return findLlmNodeId();
  if (operation === 'execute_tool') {
    return findToolNodeId(graph, span.attributes['gen_ai.tool.name'] as string | undefined);
  }
  return undefined;
}
