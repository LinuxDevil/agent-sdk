import type { AgentGraphSpec } from '../../graph/types';

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
