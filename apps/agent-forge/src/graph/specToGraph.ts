import type { AgentSpec } from '@loushy/build-ai-agent';
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
  const nodes: AgentGraphNode[] = [];
  const edges: AgentGraphEdge[] = [];
  let nextId = 0;
  const id = (prefix: string) => `${prefix}-${nextId++}`;

  const triggerIds: string[] = [];
  (spec.triggers ?? []).forEach((trigger, i) => {
    const nodeId = id('trigger');
    triggerIds.push(nodeId);
    nodes.push({
      id: nodeId,
      type: 'trigger',
      position: { x: 0, y: i * ROW_HEIGHT },
      label: trigger.type,
      data: { trigger: { ...trigger } },
    });
  });

  const llmId = id('llm');
  const llmRowY = (Math.max(triggerIds.length, 1) - 1) * ROW_HEIGHT * 0.5;
  nodes.push({
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
  for (const triggerId of triggerIds) {
    edges.push({ id: `edge-${triggerId}-${llmId}`, source: triggerId, target: llmId });
  }

  const toolIds: string[] = [];
  (spec.tools ?? []).forEach((toolName, i) => {
    const nodeId = id('tool');
    toolIds.push(nodeId);
    nodes.push({
      id: nodeId,
      type: 'tool',
      position: { x: COLUMN_WIDTH * 2, y: i * ROW_HEIGHT },
      label: toolName,
      data: { toolName },
    });
    edges.push({ id: `edge-${llmId}-${nodeId}`, source: llmId, target: nodeId });
  });

  let approvalId: string | undefined;
  if (spec.policy) {
    approvalId = id('approval');
    nodes.push({
      id: approvalId,
      type: 'approval',
      position: { x: COLUMN_WIDTH * 3, y: 0 },
      label: 'Human approval',
      data: { policy: { ...spec.policy } },
    });
    if (toolIds.length > 0) {
      for (const toolId of toolIds) {
        edges.push({ id: `edge-${toolId}-${approvalId}`, source: toolId, target: approvalId });
      }
    } else {
      edges.push({ id: `edge-${llmId}-${approvalId}`, source: llmId, target: approvalId });
    }
  }

  const outputId = id('output');
  const outputColumn = spec.policy ? 4 : 3;
  nodes.push({
    id: outputId,
    type: 'output',
    position: { x: COLUMN_WIDTH * outputColumn, y: 0 },
    label: 'Output',
    data: {},
  });
  if (approvalId) {
    edges.push({ id: `edge-${approvalId}-${outputId}`, source: approvalId, target: outputId });
  } else if (toolIds.length > 0) {
    for (const toolId of toolIds) {
      edges.push({ id: `edge-${toolId}-${outputId}`, source: toolId, target: outputId });
    }
  } else {
    edges.push({ id: `edge-${llmId}-${outputId}`, source: llmId, target: outputId });
  }

  // LOU-Q3: re-attach hooks serialized under spec.policy.hooks (see
  // graphToSpec.ts) back onto whichever freshly-built node has a matching
  // `hookNodeKey()`. Best-effort by design: `spec.policy` is an open
  // passthrough record (see AgentSpecPolicy), so anything there that isn't
  // shaped like `SerializedHook[]` is silently ignored rather than thrown
  // on - a hand-edited or older spec file without hooks still loads fine.
  const rawHooks = spec.policy?.hooks;
  if (isSerializedHookArray(rawHooks)) {
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

  return { version: 1, nodes, edges };
}
