/**
 * `KindRules` for `flow` nodes — one node per `AgentFlow` step
 * (`flow:<step id>`), owned by the root agent. `connectFrom` implements the
 * step-tree rewiring a drawn `flow → flow` edge means (append to a
 * container, append a router option, set a loop body, insert after a leaf
 * in a sequence); `attachNewStep` is the palette-add/drop hook that keeps
 * every new step attached (no orphans); `validate` checks the step fields
 * the Inspector edits. `setOptionCondition` is the router-condition setter
 * C25's Inspector uses.
 */
import type { ConnectResult, KindRules } from '../kindRules';
import { flowChildIds, flowParent, flowRoot, flowSpecPath, removeFlowChild } from '../flow';
import { dedupeId, nextItemId, toolNodeName } from '../nodeIds';
import { EXECUTABLE_TYPES, type ToolRef } from '../specTypes';
import type {
  FlowChildren,
  FlowNodeData,
  Graph,
  GraphNode,
  NodeOfKind,
  Problem,
  ToolNodeData,
} from '../types';
import { ROOT_AGENT_ID } from '../types';

/** Step `variable`/`outputVariable` names: the pattern the spec's flow validation enforces. */
const VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The executable step types — the canvas never creates editor-only shapes (PLAN §16.2). */
const RUNNABLE_TYPES: ReadonlySet<string> = new Set(EXECUTABLE_TYPES);

function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

function liveFlowNodes(graph: Graph): NodeOfKind<'flow'>[] {
  return graph.nodes.filter((n): n is NodeOfKind<'flow'> => n.kind === 'flow' && n.proposed !== 'remove');
}

function nodeOf(graph: Graph, id: string): GraphNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

/** Every step id in use — the `taken` set for `nextStepId`. */
function usedStepIds(graph: Graph): string[] {
  return liveFlowNodes(graph).map((n) => n.data.step.id);
}

/** The next free step id: `'s' + smallest n` not used by any live flow step. */
export function nextStepId(graph: Graph): string {
  return nextItemId('s', usedStepIds(graph));
}

/** `name` as a flow `code`: lowercase words joined by dashes (`'My Bot'` → `'my-bot'`). */
function flowCode(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'flow';
}

/** The root agent's display name (for a brand-new flow's `flowMeta`). */
function rootAgentName(graph: Graph): string {
  const root = nodeOf(graph, ROOT_AGENT_ID);
  const name = root?.kind === 'agent' ? root.data.fields.name : undefined;
  return typeof name === 'string' ? name : '';
}

/**
 * The empty `FlowChildren` for a step `type` — what a palette `create`
 * emits (`sequence`/`parallel` → empty `steps`, `oneOf` → empty `options`,
 * `forEach` → empty `step`, leaves → `none`).
 */
export function emptyFlowChildren(stepType: string): FlowChildren {
  if (stepType === 'sequence' || stepType === 'parallel') return { shape: 'steps', ids: [] };
  if (stepType === 'oneOf') return { shape: 'options', options: [] };
  if (stepType === 'forEach') return { shape: 'step', id: null };
  return { shape: 'none' };
}

/**
 * The children a container step *effectively* has: `none` on a
 * sequence/parallel/oneOf/forEach means "empty" (a palette-created or
 * hand-built node), so it reads as the empty shape of its type. Leaf types
 * keep `none`.
 */
function effectiveChildren(data: FlowNodeData): FlowChildren {
  if (data.children.shape !== 'none') return data.children;
  return emptyFlowChildren(String(data.step.type));
}

/** `graph` with `nodeId`'s `data` replaced by `data`. */
function withNodeData(graph: Graph, nodeId: string, data: FlowNodeData): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId && n.kind === 'flow' ? { ...n, data } : n)),
  };
}

/** `targetId` detached from its current parent's children (no-op when it has none). */
function detachTarget(graph: Graph, targetId: string): Graph {
  const parentId = flowParent(graph, targetId);
  if (parentId === undefined) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === parentId ? removeFlowChild(n, targetId) : n)),
  };
}

/** Append `childId` to a `steps`-shaped (or empty sequence/parallel) node's children. */
function appendStep(graph: Graph, parentId: string, childId: string): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== parentId || n.kind !== 'flow') return n;
      const data = n.data as FlowNodeData;
      const children = effectiveChildren(data);
      if (children.shape !== 'steps') return n;
      return { ...n, data: { ...data, children: { shape: 'steps', ids: [...children.ids, childId] } } };
    }),
  };
}

/** Append `{ id: childId }` (a condition-less default option) to a `oneOf` node's children. */
function appendOption(graph: Graph, routerId: string, childId: string): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== routerId || n.kind !== 'flow') return n;
      const data = n.data as FlowNodeData;
      const children = effectiveChildren(data);
      if (children.shape !== 'options') return n;
      return {
        ...n,
        data: { ...data, children: { shape: 'options', options: [...children.options, { id: childId }] } },
      };
    }),
  };
}

/** Set a `forEach` node's empty `step` child to `childId`. */
function setLoopStep(graph: Graph, loopId: string, childId: string): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== loopId || n.kind !== 'flow') return n;
      const data = n.data as FlowNodeData;
      const children = effectiveChildren(data);
      if (children.shape !== 'step' || children.id !== null) return n;
      return { ...n, data: { ...data, children: { shape: 'step', id: childId } } };
    }),
  };
}

/** Insert `childId` right after `afterId` in a `steps`-shaped parent's children. */
function insertAfter(graph: Graph, parentId: string, afterId: string, childId: string): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== parentId || n.kind !== 'flow') return n;
      const data = n.data as FlowNodeData;
      if (data.children.shape !== 'steps') return n;
      const index = data.children.ids.indexOf(afterId);
      if (index === -1) return n;
      const ids = [...data.children.ids];
      ids.splice(index + 1, 0, childId);
      return { ...n, data: { ...data, children: { shape: 'steps', ids } } };
    }),
  };
}

/** Whether `ancestorId` is `nodeId` itself or one of its flow ancestors. */
function isSelfOrAncestor(graph: Graph, ancestorId: string, nodeId: string): boolean {
  let current: string | undefined = nodeId;
  while (current !== undefined) {
    if (current === ancestorId) return true;
    current = flowParent(graph, current);
  }
  return false;
}

/**
 * Where a palette-added step goes — first match wins, so a new step is
 * never an orphan:
 * 1. no flow root → the new node becomes the root (`flowMeta` seeded from the agent);
 * 2. selected node is a container → append / append option / set loop step;
 * 3. selected node's parent is a sequence → insert right after it;
 * 4. root is a sequence → append to the root;
 * 5. otherwise → wrap root + new node in a new sequence root.
 */
export function attachNewStep(graph: Graph, newNodeId: string, selectedNodeId?: string): Graph {
  const newNode = nodeOf(graph, newNodeId);
  if (newNode === undefined || newNode.kind !== 'flow') return graph;
  // The flow root *before* this node existed: the new node is itself
  // unreferenced, so `flowRoot` would wrongly pick it (or an earlier orphan)
  // — exclude it from both the candidates and the reference scan.
  const flows = liveFlowNodes(graph).filter((n) => n.id !== newNodeId);
  const referenced = new Set(flows.flatMap(flowChildIds));
  const root = flows.find((n) => !referenced.has(n.id));
  if (root === undefined) {
    const name = rootAgentName(graph);
    const flowMeta = { code: flowCode(name), name } as FlowNodeData['flowMeta'];
    return withNodeData(graph, newNodeId, { ...(newNode.data as FlowNodeData), flowMeta });
  }
  const selected =
    selectedNodeId === undefined ? undefined : nodeOf(graph, selectedNodeId);
  if (selected !== undefined && selected.kind === 'flow') {
    const children = effectiveChildren(selected.data as FlowNodeData);
    // Rule 2: the selected node is a container.
    if (children.shape === 'steps') return appendStep(graph, selected.id, newNodeId);
    if (children.shape === 'options') return appendOption(graph, selected.id, newNodeId);
    if (children.shape === 'step' && children.id === null) return setLoopStep(graph, selected.id, newNodeId);
    // Rule 3: insert right after the selected step inside its sequence parent.
    const parentId = flowParent(graph, selected.id);
    if (parentId !== undefined) {
      const parent = nodeOf(graph, parentId);
      const parentChildren = parent?.kind === 'flow' ? (parent.data as FlowNodeData).children : undefined;
      if (parentChildren?.shape === 'steps') return insertAfter(graph, parentId, selected.id, newNodeId);
    }
  }
  const rootChildren = (root.data as FlowNodeData).children;
  // Rule 4: the root is a sequence — append there.
  if ((root.data as FlowNodeData).step.type === 'sequence' && rootChildren.shape === 'steps') {
    return appendStep(graph, root.id, newNodeId);
  }
  // Rule 5: wrap the old root and the new step in a new sequence root.
  const wrapperId = nextStepId(graph);
  const taken = new Set(graph.nodes.map((n) => n.id));
  const wrapperNodeId = dedupeId(`flow:${wrapperId}`, taken);
  const wrapperData: FlowNodeData = {
    step: { type: 'sequence', id: wrapperId },
    children: { shape: 'steps', ids: [root.id, newNodeId] },
  };
  const rootFlowMeta = (root.data as FlowNodeData).flowMeta;
  if (rootFlowMeta !== undefined) wrapperData.flowMeta = rootFlowMeta;
  const wrapper: GraphNode = {
    id: wrapperNodeId,
    kind: 'flow',
    owner: ROOT_AGENT_ID,
    position: { ...root.position },
    data: wrapperData,
  };
  const rootData = { ...(root.data as FlowNodeData) };
  delete rootData.flowMeta;
  return {
    ...graph,
    nodes: [
      ...graph.nodes.map((n) =>
        n.id === root.id && n.kind === 'flow' ? { ...n, data: rootData } : n
      ),
      wrapper,
    ],
  };
}

/**
 * `flow → flow` connect effect: `target` becomes a child of `source` —
 * appended to a sequence/parallel or as a router option, set as a loop's
 * step, or inserted after `source` when `source` is a leaf inside a
 * sequence. Exact refusal texts per the ticket table.
 */
function connectFlow(source: NodeOfKind<'flow'>, target: GraphNode, graph: Graph): ConnectResult {
  const targetId = target.id;
  // The root can never become a child — check it before the cycle guard so
  // the refusal names the real problem ('cannot move', not 'cannot contain').
  if (flowRoot(graph)?.id === targetId) {
    return { ok: false, reason: 'The first step of the flow cannot move' };
  }
  if (targetId === source.id || isSelfOrAncestor(graph, targetId, source.id)) {
    return { ok: false, reason: 'A step cannot contain itself' };
  }
  const children = effectiveChildren(source.data as FlowNodeData);
  const detached = detachTarget(graph, targetId);
  if (children.shape === 'steps') return { ok: true, graph: appendStep(detached, source.id, targetId) };
  if (children.shape === 'options') return { ok: true, graph: appendOption(detached, source.id, targetId) };
  if (children.shape === 'step') {
    if (children.id === null) return { ok: true, graph: setLoopStep(detached, source.id, targetId) };
    return { ok: false, reason: 'A loop runs one step. Put several in a sequence.' };
  }
  // Leaf source: insert after it when its parent is a sequence.
  const parentId = flowParent(detached, source.id);
  if (parentId !== undefined) {
    const parent = nodeOf(detached, parentId);
    const parentChildren = parent?.kind === 'flow' ? (parent.data as FlowNodeData).children : undefined;
    if (parentChildren?.shape === 'steps') {
      return { ok: true, graph: insertAfter(detached, parentId, source.id, targetId) };
    }
  }
  return { ok: false, reason: 'Put these steps in a sequence first' };
}

/** `flowRules`: validation plus the flow → flow connect effect. */
export const flowRules: KindRules<'flow'> = {
  validate: (node, graph) => validateFlowNode(node, graph),
  connectFrom: connectFlow,
};

/** `problem` helpers with the flow node's spec path (`flow.flow.steps[1]`, …). */
function flowProblem(
  node: NodeOfKind<'flow'>,
  graph: Graph,
  severity: Problem['severity'],
  message: string,
  field?: string
): Problem {
  const path = flowSpecPath(graph, node.id) ?? 'flow.flow';
  return {
    nodeId: node.id,
    severity,
    message,
    fieldPath: field === undefined ? path : `${path}.${field}`,
  };
}

/** The tool names the root agent can call — `toolNodeName` of its `tool` nodes. */
function rootToolNames(graph: Graph): Set<string> {
  const names = new Set<string>();
  for (const n of graph.nodes) {
    if (n.kind === 'tool' && n.owner === ROOT_AGENT_ID && n.proposed !== 'remove') {
      names.add(toolNodeName((n.data as ToolNodeData).item as ToolRef));
    }
  }
  return names;
}

/** The type-specific rows of `flowRules.validate`; each returns its problems. */
function typeProblems(node: NodeOfKind<'flow'>, graph: Graph): Problem[] {
  const { step, children } = node.data;
  const type = String(step.type);
  const problems: Problem[] = [];
  const error = (message: string, field?: string) => problems.push(flowProblem(node, graph, 'error', message, field));
  const warning = (message: string, field?: string) => problems.push(flowProblem(node, graph, 'warning', message, field));
  if (!RUNNABLE_TYPES.has(type)) {
    error('This step type cannot run', 'type');
    return problems;
  }
  if (type === 'sequence' || type === 'parallel') {
    const count = children.shape === 'steps' ? children.ids.length : 0;
    if (count === 0) warning('This step has nothing inside');
  } else if (type === 'oneOf') {
    const options = children.shape === 'options' ? children.options : [];
    if (options.length < 2) {
      error('A router needs at least two branches');
    } else if (options.filter((o) => o.condition === undefined).length > 1) {
      error('A router can have only one default branch', 'options');
    }
  } else if (type === 'forEach') {
    if (children.shape !== 'step' || children.id === null) warning('This loop has no step to run', 'step');
  } else if (type === 'llmCall') {
    if (blank(step.prompt)) error('Write the prompt for this model call', 'prompt');
  } else if (type === 'toolCall') {
    if (blank(step.tool)) {
      error('Pick the tool to call', 'tool');
    } else if (!rootToolNames(graph).has(String(step.tool))) {
      warning(`The agent has no tool named '${String(step.tool)}'`, 'tool');
    }
  } else if (type === 'setVariable') {
    if (blank(step.variable) || !VARIABLE_PATTERN.test(String(step.variable))) {
      error('Use a variable name like order_id', 'variable');
    }
  } else if (type === 'agent') {
    if (blank(step.agent)) error('Pick the agent to run', 'agent');
  } else if (type === 'approval') {
    if (blank(step.message)) error('Write what the person approves', 'message');
  }
  const outputVariable = step.outputVariable;
  if (
    typeof outputVariable === 'string' &&
    outputVariable !== '' &&
    !VARIABLE_PATTERN.test(outputVariable)
  ) {
    error('Use a variable name like order_id', 'outputVariable');
  }
  return problems;
}

/** `flowRules.validate`: the type rules plus the shared-id check. */
function validateFlowNode(node: NodeOfKind<'flow'>, graph: Graph): Problem[] {
  const problems = typeProblems(node, graph);
  const id = node.data.step.id;
  const shared = liveFlowNodes(graph).filter((n) => n.data.step.id === id);
  if (shared.length > 1) {
    problems.push(flowProblem(node, graph, 'error', `Two flow steps use the id '${id}'`, 'id'));
  }
  return problems;
}

/**
 * Sets a router option's `condition` (`trimmed`; empty removes it — the
 * option becomes the default branch). C25's condition editor calls this.
 */
export function setOptionCondition(graph: Graph, routerId: string, childId: string, condition: string): Graph {
  const trimmed = condition.trim();
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== routerId || n.kind !== 'flow') return n;
      const data = n.data as FlowNodeData;
      if (data.children.shape !== 'options') return n;
      const options = data.children.options.map((option) => {
        if (option.id !== childId) return option;
        if (trimmed === '') {
          return { id: option.id };
        }
        return { ...option, condition: trimmed };
      });
      return { ...n, data: { ...data, children: { shape: 'options', options } } };
    }),
  };
}
