import type { AgentGraphSpec } from '../../graph/types';
import type { SpanEvent } from '../../../shared/wireTypes';

/**
 * Shared by the Logs and Trace panels: map a log line / span back to the
 * canvas node it describes so clicking either can highlight that node.
 */
export function findLlmNodeId(graph: AgentGraphSpec): string | undefined {
  return graph.nodes.find((n) => n.type === 'llm')?.id;
}

export function findToolNodeId(graph: AgentGraphSpec, toolName: string | undefined): string | undefined {
  if (!toolName) return undefined;
  return graph.nodes.find((n) => n.type === 'tool' && n.data.toolName === toolName)?.id;
}

/** The canvas node a span describes: `chat` spans are the llm node, `execute_tool` spans their tool's node. */
export function nodeIdForSpan(graph: AgentGraphSpec, span: SpanEvent): string | undefined {
  // SDK spans follow the OpenTelemetry GenAI conventions: the operation is
  // `chat` (model call) or `execute_tool` (tool call).
  const operation = span.attributes['gen_ai.operation.name'];
  if (operation === 'chat') return findLlmNodeId(graph);
  if (operation === 'execute_tool') {
    return findToolNodeId(graph, span.attributes['gen_ai.tool.name'] as string | undefined);
  }
  return undefined;
}
