import type { AgentSpec, AgentSpecTrigger } from '@loushy/build-ai-agent';
import type { AgentGraphSpec } from './types';

/**
 * Converts a canvas graph to the SDK's declarative `AgentSpec` (see
 * src/spec/schema.ts in the core SDK). Reads node `data` only - edges carry
 * no information `AgentSpec` can represent (see graph/types.ts for why) -
 * so wiring/order in the canvas does not affect the resulting spec beyond
 * "which nodes of which type exist".
 *
 * Throws if the graph has no `llm` node, since `AgentSpec` requires
 * `name`/`prompt`/`provider` and there is nowhere else in the graph to
 * source them from.
 */
export function graphToSpec(graph: AgentGraphSpec): AgentSpec {
  const llmNode = graph.nodes.find((n) => n.type === 'llm');
  if (!llmNode || llmNode.type !== 'llm') {
    throw new Error('graphToSpec: graph has no llm node - AgentSpec requires name/prompt/provider');
  }

  const spec: AgentSpec = {
    name: llmNode.data.name,
    prompt: llmNode.data.prompt,
    provider: { ...llmNode.data.provider },
  };

  const toolNodes = graph.nodes.filter((n) => n.type === 'tool');
  if (toolNodes.length > 0) {
    spec.tools = toolNodes.map((n) => (n.type === 'tool' ? n.data.toolName : '')).filter(Boolean);
  }

  const approvalNode = graph.nodes.find((n) => n.type === 'approval');
  if (approvalNode && approvalNode.type === 'approval') {
    spec.policy = { ...approvalNode.data.policy };
  }

  const triggerNodes = graph.nodes.filter((n) => n.type === 'trigger');
  if (triggerNodes.length > 0) {
    spec.triggers = triggerNodes.map((n) =>
      n.type === 'trigger' ? ({ ...n.data.trigger } as AgentSpecTrigger) : ({} as AgentSpecTrigger)
    );
  }

  return spec;
}
