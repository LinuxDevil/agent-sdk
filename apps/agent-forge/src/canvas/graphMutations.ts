import type {
  AgentGraphEdge,
  AgentGraphNode,
  AgentGraphNodeType,
  AgentGraphSpec,
  GraphPosition,
} from '../graph/types';
import { isEdgeTypeAllowed } from '../graph/connectionRules';

/**
 * Pure, canvas-agnostic mutations over `AgentGraphSpec` (LOU-M2).
 *
 * `CanvasArea` calls these in response to ReactFlow interaction events, but
 * none of these functions know anything about ReactFlow: they take the
 * app's canonical `AgentGraphSpec` and return a new one. That's the seam
 * the epic's constraint asks for - "the ReactFlow instance's own internal
 * state should be a view over your app's canonical graph state, not a
 * second source of truth" - and it's what makes these easy to unit test
 * without mounting a canvas at all.
 */

let idCounter = 0;
/** Overridable so tests can assert on deterministic ids. */
export function nextNodeId(type: AgentGraphNodeType): string {
  idCounter += 1;
  return `${type}-${Date.now().toString(36)}-${idCounter}`;
}

export function defaultNodeData(type: AgentGraphNodeType): AgentGraphNode['data'] {
  switch (type) {
    case 'trigger':
      return { trigger: { type: 'input' } };
    case 'llm':
      return { name: 'new-step', prompt: '', provider: { type: 'mock', model: 'mock-1' } };
    case 'tool':
      return { toolName: '' };
    case 'approval':
      return { policy: { requiresApproval: true } };
    case 'output':
      return {};
  }
}

export function defaultNodeLabel(type: AgentGraphNodeType): string {
  switch (type) {
    case 'trigger':
      return 'Trigger';
    case 'llm':
      return 'LLM step';
    case 'tool':
      return 'Tool';
    case 'approval':
      return 'Human approval';
    case 'output':
      return 'Output';
  }
}

/** Adds a new node of `type` at `position` with sensible default data. */
export function addNode(graph: AgentGraphSpec, type: AgentGraphNodeType, position: GraphPosition): AgentGraphSpec {
  const id = nextNodeId(type);
  const node = {
    id,
    type,
    position,
    label: defaultNodeLabel(type),
    data: defaultNodeData(type),
  } as AgentGraphNode;
  return { ...graph, nodes: [...graph.nodes, node] };
}

/** Removes a node and any edge touching it. */
export function removeNode(graph: AgentGraphSpec, nodeId: string): AgentGraphSpec {
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => n.id !== nodeId),
    edges: graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
  };
}

/** Clones a node (new id, offset position, same data/type) with no edges. */
export function duplicateNode(graph: AgentGraphSpec, nodeId: string): AgentGraphSpec {
  const source = graph.nodes.find((n) => n.id === nodeId);
  if (!source) return graph;
  const id = nextNodeId(source.type);
  const clone = {
    ...source,
    id,
    label: `${source.label} copy`,
    position: { x: source.position.x + 40, y: source.position.y + 40 },
    data: structuredClone(source.data),
  } as AgentGraphNode;
  return { ...graph, nodes: [...graph.nodes, clone] };
}

/** Renames a node's display label (and, for an `llm` node, its `data.name`). */
export function renameNode(graph: AgentGraphSpec, nodeId: string, label: string): AgentGraphSpec {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      if (n.type === 'llm') {
        return { ...n, label, data: { ...n.data, name: label } };
      }
      return { ...n, label };
    }),
  };
}

/** Moves a node to a new canvas position (e.g. after a ReactFlow drag). */
export function moveNode(graph: AgentGraphSpec, nodeId: string, position: GraphPosition): AgentGraphSpec {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n)),
  };
}

/**
 * Shallow-merges a data patch into a node, preserving its discriminant
 * `type`. Untyped (`Record<string, unknown>`) rather than generic over
 * `AgentGraphNode` - callers (Inspector.tsx) already narrow `selected` by
 * `selected.type` before building the patch, so the patch shape is
 * type-checked at the call site; a type parameter here can't be inferred
 * from the patch object alone since `AgentGraphNode['data']` is a union.
 */
export function updateNodeData(graph: AgentGraphSpec, nodeId: string, patch: Record<string, unknown>): AgentGraphSpec {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId ? ({ ...n, data: { ...n.data, ...patch } } as AgentGraphNode) : n)),
  };
}

export type ConnectResult =
  | { ok: true; graph: AgentGraphSpec }
  | { ok: false; reason: string };

/**
 * Attempts to connect two nodes by id. Rejects (without mutating) when
 * either node is missing, the pair is already connected, or the port
 * types are incompatible per connectionRules.ts - the same rule
 * validateGraph() enforces, applied here so an invalid drag is rejected
 * inline instead of only at save/validate time.
 */
export function connectNodes(graph: AgentGraphSpec, sourceId: string, targetId: string): ConnectResult {
  if (sourceId === targetId) {
    return { ok: false, reason: "Can't connect a node to itself" };
  }
  const source = graph.nodes.find((n) => n.id === sourceId);
  const target = graph.nodes.find((n) => n.id === targetId);
  if (!source || !target) {
    return { ok: false, reason: 'Unknown source or target node' };
  }
  if (!isEdgeTypeAllowed(source.type, target.type)) {
    return { ok: false, reason: `Can't connect ${source.type} → ${target.type}: not a valid pipeline connection` };
  }
  const alreadyConnected = graph.edges.some((e) => e.source === sourceId && e.target === targetId);
  if (alreadyConnected) {
    return { ok: false, reason: 'Nodes are already connected' };
  }
  const edge: AgentGraphEdge = { id: `edge-${sourceId}-${targetId}-${idCounter++}`, source: sourceId, target: targetId };
  return { ok: true, graph: { ...graph, edges: [...graph.edges, edge] } };
}

export function removeEdge(graph: AgentGraphSpec, edgeId: string): AgentGraphSpec {
  return { ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) };
}
