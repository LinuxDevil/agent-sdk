import type { AgentSpec, AgentSpecTrigger } from '@loushy/build-ai-agent';
import type { AgentGraphNode, AgentGraphSpec } from './types';
import { graphToFlow, hasRouterNode } from './graphToFlow';

/**
 * Stable key identifying which node a serialized hook belongs to, used
 * instead of the node's own `id` because `specToGraph()` always
 * regenerates fresh node ids on every load (see graph/types.ts's file
 * header) - an id-keyed hook would never re-attach after a round trip.
 * `llm` is unique per graph; `tool` nodes are keyed by tool name, which is
 * unique within the fixed-pipeline shape this app supports today (see
 * graph/types.ts).
 */
export function hookNodeKey(node: AgentGraphNode): string {
  if (node.type === 'tool') return `tool:${node.data.toolName}`;
  return node.type;
}

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

  // LOU-Q3: serialize every ENABLED hook on every node into `spec.policy`,
  // the one open/passthrough record `AgentSpec` already has (see
  // src/spec/schema.ts's doc comment on `AgentSpecPolicy` - `[key: string]:
  // unknown`, deliberately extensible without a core schema migration).
  // This is what lets the app's runtime control server (LOU-N,
  // server/runRegistry.ts) compile a real SDK `HookRegistry` and pass it
  // into `AgentExecutor.execute()`'s `hooks` option purely from the
  // `AgentSpec` it already transports over the wire - no separate endpoint
  // or second source of truth for "what hooks does this agent run with".
  // Disabled hooks are left out entirely: a disabled hook has no runtime
  // effect, and there's no reason to make the compiled server side account
  // for `enabled: false` when the Inspector's toggle already filtered it.
  const serializedHooks = graph.nodes.flatMap((n) =>
    (n.hooks ?? [])
      .filter((h) => h.enabled)
      .map((h) => ({ nodeKey: hookNodeKey(n), id: h.id, name: h.name, phase: h.phase, point: h.point, code: h.code }))
  );
  if (serializedHooks.length > 0) {
    spec.policy = { ...spec.policy, hooks: serializedHooks };
  }

  // LOU-T3: a graph with a `router` node compiles to a real branching
  // `AgentFlow` (graphToFlow.ts) rather than the fixed
  // trigger->llm->tool->[approval]->output pipeline shape `AgentSpec`
  // itself can express. There is nowhere else in `AgentSpec` to carry this
  // - it's stashed under `spec.policy.flow`, the same deliberately open
  // passthrough record LOU-Q3 already uses for `spec.policy.hooks` above,
  // so it round-trips over the exact same wire contract (PUT/POST
  // `AgentSpec` JSON) without any server API change. `server/buildAgent.ts`
  // reads it back to decide `AgentExecutor.execute()` vs. `FlowExecutor`.
  if (hasRouterNode(graph)) {
    spec.policy = { ...spec.policy, flow: graphToFlow(graph, llmNode.data.name) };
  }

  return spec;
}
