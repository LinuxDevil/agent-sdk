import type { AgentSpec } from '@lousho/build-ai-agent';
import type { AgentGraphEdge, AgentGraphNode, AgentGraphSpec, AgentNodeHookInstance } from './types';
import { hookNodeKey } from './graphToSpec';

/** Shape `graphToSpec()` serializes each hook as, under `spec.policy.hooks`. */
interface SerializedHook {
  nodeKey: string;
  id: string;
  name: string;
  phase: AgentNodeHookInstance['phase'];
  point: AgentNodeHookInstance['point'];
  code: string;
}

function isSerializedHookArray(value: unknown): value is SerializedHook[] {
  return (
    Array.isArray(value) &&
    value.every(
      (h) => h && typeof h === 'object' && typeof (h as SerializedHook).nodeKey === 'string' && typeof (h as SerializedHook).id === 'string'
    )
  );
}

const COLUMN_WIDTH = 260;
const ROW_HEIGHT = 140;

/**
 * Auto-layout accumulator: nodes/edges built so far plus the shared id
 * counter, so ids stay `<prefix>-<n>` in construction order.
 */
interface GraphBuilder {
  nodes: AgentGraphNode[];
  edges: AgentGraphEdge[];
  id: (prefix: string) => string;
}

function connect(builder: GraphBuilder, source: string, target: string): void {
  builder.edges.push({ id: `edge-${source}-${target}`, source, target });
}

function addTriggerNodes(builder: GraphBuilder, spec: AgentSpec): string[] {
  const triggerIds: string[] = [];
  (spec.triggers ?? []).forEach((trigger, i) => {
    const nodeId = builder.id('trigger');
    triggerIds.push(nodeId);
    builder.nodes.push({
      id: nodeId,
      type: 'trigger',
      position: { x: 0, y: i * ROW_HEIGHT },
      label: trigger.type,
      data: { trigger: { ...trigger } },
    });
  });
  return triggerIds;
}

function addLlmNode(builder: GraphBuilder, spec: AgentSpec, triggerIds: string[]): string {
  const llmId = builder.id('llm');
  const llmRowY = (Math.max(triggerIds.length, 1) - 1) * ROW_HEIGHT * 0.5;
  builder.nodes.push({
    id: llmId,
    type: 'llm',
    position: { x: COLUMN_WIDTH, y: llmRowY },
    label: spec.name,
    data: {
      name: spec.name,
      prompt: spec.prompt,
      provider: { ...spec.provider },
    },
  });
  for (const triggerId of triggerIds) connect(builder, triggerId, llmId);
  return llmId;
}

function addToolNodes(builder: GraphBuilder, spec: AgentSpec, llmId: string): string[] {
  const toolIds: string[] = [];
  (spec.tools ?? []).forEach((toolName, i) => {
    const nodeId = builder.id('tool');
    toolIds.push(nodeId);
    builder.nodes.push({
      id: nodeId,
      type: 'tool',
      position: { x: COLUMN_WIDTH * 2, y: i * ROW_HEIGHT },
      label: toolName,
      data: { toolName },
    });
    connect(builder, llmId, nodeId);
  });
  return toolIds;
}

/** Sources feeding the next stage: the tool nodes if any, else the llm node. */
function upstreamOf(llmId: string, toolIds: string[]): string[] {
  return toolIds.length > 0 ? toolIds : [llmId];
}

function addApprovalNode(
  builder: GraphBuilder,
  policy: NonNullable<AgentSpec['policy']>,
  upstream: string[]
): string {
  const approvalId = builder.id('approval');
  builder.nodes.push({
    id: approvalId,
    type: 'approval',
    position: { x: COLUMN_WIDTH * 3, y: 0 },
    label: 'Human approval',
    data: { policy: { ...policy } },
  });
  for (const source of upstream) connect(builder, source, approvalId);
  return approvalId;
}

function addOutputNode(builder: GraphBuilder, hasPolicy: boolean, upstream: string[]): void {
  const outputId = builder.id('output');
  const outputColumn = hasPolicy ? 4 : 3;
  builder.nodes.push({
    id: outputId,
    type: 'output',
    position: { x: COLUMN_WIDTH * outputColumn, y: 0 },
    label: 'Output',
    data: {},
  });
  for (const source of upstream) connect(builder, source, outputId);
}

/**
 * LOU-Q3: re-attach hooks serialized under spec.policy.hooks (see
 * graphToSpec.ts) back onto whichever freshly-built node has a matching
 * `hookNodeKey()`. Best-effort by design: `spec.policy` is an open
 * passthrough record (see AgentSpecPolicy), so anything there that isn't
 * shaped like `SerializedHook[]` is silently ignored rather than thrown
 * on - a hand-edited or older spec file without hooks still loads fine.
 */
function reattachHooks(nodes: AgentGraphNode[], rawHooks: unknown): void {
  if (!isSerializedHookArray(rawHooks)) return;
  const byNodeKey = new Map<string, SerializedHook[]>();
  for (const h of rawHooks) {
    const list = byNodeKey.get(h.nodeKey) ?? [];
    list.push(h);
    byNodeKey.set(h.nodeKey, list);
  }
  for (const node of nodes) {
    const matched = byNodeKey.get(hookNodeKey(node));
    if (matched && matched.length > 0) {
      node.hooks = matched.map((h) => ({
        id: h.id,
        templateId: 'custom',
        name: h.name,
        phase: h.phase,
        point: h.point,
        enabled: true,
        code: h.code,
      }));
    }
  }
}

/**
 * Converts an `AgentSpec` to a fresh canvas graph. There is no stored
 * canvas layout in `AgentSpec` (see graph/types.ts), so this always
 * computes a new auto-layout: one column per pipeline stage
 * (trigger -> llm -> tool -> approval -> output), stacking multiple nodes
 * in the same stage vertically.
 */
/**
 * LOU-T3 known limitation: `spec.policy.flow` (the compiled `AgentFlow` a
 * router graph's `graphToSpec()` stashes there - see that file) is NOT
 * read back here. A saved branching graph still round-trips through its
 * `llm`/`tool`/`output`/etc. node data exactly like today, but reloading it
 * regenerates the plain auto-layout pipeline (no `router` node, no branch
 * edges) rather than reconstructing the original branching shape - the
 * same category of loss `graph/types.ts`'s file header already documents
 * for edges/position. A future pass could add a `flowToGraph()` the same
 * way `specToGraph()` exists today; out of scope for this ticket.
 */
export function specToGraph(spec: AgentSpec): AgentGraphSpec {
  let nextId = 0;
  const builder: GraphBuilder = { nodes: [], edges: [], id: (prefix) => `${prefix}-${nextId++}` };

  const triggerIds = addTriggerNodes(builder, spec);
  const llmId = addLlmNode(builder, spec, triggerIds);
  const toolIds = addToolNodes(builder, spec, llmId);
  const upstream = upstreamOf(llmId, toolIds);

  const outputUpstream = spec.policy ? [addApprovalNode(builder, spec.policy, upstream)] : upstream;
  addOutputNode(builder, Boolean(spec.policy), outputUpstream);

  reattachHooks(builder.nodes, spec.policy?.hooks);

  return { version: 1, nodes: builder.nodes, edges: builder.edges };
}
