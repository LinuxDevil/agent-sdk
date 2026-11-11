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

/** `graph` with `nodeId`'s flow data replaced by `updater`'s result (`undefined` keeps the node). */
function mapFlowData(
  graph: Graph,
  nodeId: string,
  updater: (data: FlowNodeData) => FlowNodeData | undefined
): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== nodeId || n.kind !== 'flow') return n;
      const next = updater(n.data as FlowNodeData);
      return next === undefined ? n : { ...n, data: next };
    }),
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
  return mapFlowData(graph, parentId, (data) => {
    const children = effectiveChildren(data);
    if (children.shape !== 'steps') return undefined;
    return { ...data, children: { shape: 'steps', ids: [...children.ids, childId] } };
  });
}

/** Append `{ id: childId }` (a condition-less default option) to a `oneOf` node's children. */
function appendOption(graph: Graph, routerId: string, childId: string): Graph {
  return mapFlowData(graph, routerId, (data) => {
    const children = effectiveChildren(data);
    if (children.shape !== 'options') return undefined;
    return { ...data, children: { shape: 'options', options: [...children.options, { id: childId }] } };
  });
}

/** Set a `forEach` node's empty `step` child to `childId`. */
function setLoopStep(graph: Graph, loopId: string, childId: string): Graph {
  return mapFlowData(graph, loopId, (data) => {
    const children = effectiveChildren(data);
    if (children.shape !== 'step' || children.id !== null) return undefined;
    return { ...data, children: { shape: 'step', id: childId } };
  });
}

/** Insert `childId` right after `afterId` in a `steps`-shaped parent's children. */
function insertAfter(graph: Graph, parentId: string, afterId: string, childId: string): Graph {
  return mapFlowData(graph, parentId, (data) => {
    if (data.children.shape !== 'steps') return undefined;
    const index = data.children.ids.indexOf(afterId);
    if (index === -1) return undefined;
    const ids = [...data.children.ids];
    ids.splice(index + 1, 0, childId);
    return { ...data, children: { shape: 'steps', ids } };
  });
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
/** Rules 2–3: attach next to the selected flow step, or `undefined` when no rule applies. */
function attachNearSelected(graph: Graph, selected: GraphNode, newNodeId: string): Graph | undefined {
  if (selected.kind !== 'flow') return undefined;
  const children = effectiveChildren(selected.data as FlowNodeData);
  // Rule 2: the selected node is a container.
  if (children.shape === 'steps') return appendStep(graph, selected.id, newNodeId);
  if (children.shape === 'options') return appendOption(graph, selected.id, newNodeId);
  if (children.shape === 'step' && children.id === null) return setLoopStep(graph, selected.id, newNodeId);
  // Rule 3: insert right after the selected step inside its sequence parent.
  const parentId = flowParent(graph, selected.id);
  if (parentId === undefined) return undefined;
  const parent = nodeOf(graph, parentId);
  const parentChildren = parent?.kind === 'flow' ? (parent.data as FlowNodeData).children : undefined;
  if (parentChildren?.shape === 'steps') return insertAfter(graph, parentId, selected.id, newNodeId);
  return undefined;
}

/** Rules 4–5: append to a sequence root, else wrap root + new step in a new sequence root. */
function attachToRoot(graph: Graph, root: NodeOfKind<'flow'>, newNodeId: string): Graph {
  const rootData = root.data as FlowNodeData;
  // Rule 4: the root is a sequence — append there.
  if (rootData.step.type === 'sequence' && rootData.children.shape === 'steps') {
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
  if (rootData.flowMeta !== undefined) wrapperData.flowMeta = rootData.flowMeta;
  const wrapper: GraphNode = {
    id: wrapperNodeId,
    kind: 'flow',
    owner: ROOT_AGENT_ID,
    position: { ...root.position },
    data: wrapperData,
  };
  const stripped = { ...rootData };
  delete stripped.flowMeta;
  return {
    ...graph,
    nodes: [
      ...graph.nodes.map((n) =>
        n.id === root.id && n.kind === 'flow' ? { ...n, data: stripped } : n
      ),
      wrapper,
    ],
  };
}

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
  const selected = selectedNodeId === undefined ? undefined : nodeOf(graph, selectedNodeId);
  const near = selected === undefined ? undefined : attachNearSelected(graph, selected, newNodeId);
  return near ?? attachToRoot(graph, root, newNodeId);
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

/**
 * The sorted list of tool names a `toolCall` step's picker offers — the
 * root agent's `tool` nodes only (probed MCP `<key>__<tool>` names are not
 * listed, per the ticket). C25's ToolCallForm reads this.
 */
export function rootToolNameList(graph: Graph): string[] {
  return [...rootToolNames(graph)].sort();
}

/** One problem, or none — the shape every per-type check returns. */
function maybeProblem(
  node: NodeOfKind<'flow'>,
  graph: Graph,
  severity: Problem['severity'],
  message: string,
  field?: string,
  applies = true
): Problem[] {
  return applies ? [flowProblem(node, graph, severity, message, field)] : [];
}

function containerProblems(node: NodeOfKind<'flow'>, graph: Graph): Problem[] {
  const children = node.data.children;
  const count = children.shape === 'steps' ? children.ids.length : 0;
  return maybeProblem(node, graph, 'warning', 'This step has nothing inside', undefined, count === 0);
}

function routerProblems(node: NodeOfKind<'flow'>, graph: Graph): Problem[] {
  const children = node.data.children;
  const options = children.shape === 'options' ? children.options : [];
  if (options.length < 2) {
    return [flowProblem(node, graph, 'error', 'A router needs at least two branches')];
  }
  const defaults = options.filter((o) => o.condition === undefined).length;
  return maybeProblem(node, graph, 'error', 'A router can have only one default branch', 'options', defaults > 1);
}

function loopProblems(node: NodeOfKind<'flow'>, graph: Graph): Problem[] {
  const children = node.data.children;
  return maybeProblem(
    node,
    graph,
    'warning',
    'This loop has no step to run',
    'step',
    children.shape !== 'step' || children.id === null
  );
}

function llmCallProblems(node: NodeOfKind<'flow'>, graph: Graph): Problem[] {
  return maybeProblem(node, graph, 'error', 'Write the prompt for this model call', 'prompt', blank(node.data.step.prompt));
}

function toolCallProblems(node: NodeOfKind<'flow'>, graph: Graph): Problem[] {
  const tool = node.data.step.tool;
  if (blank(tool)) return [flowProblem(node, graph, 'error', 'Pick the tool to call', 'tool')];
  return maybeProblem(
    node,
    graph,
    'warning',
    `The agent has no tool named '${String(tool)}'`,
    'tool',
    !rootToolNames(graph).has(String(tool))
  );
}

function variableProblems(node: NodeOfKind<'flow'>, graph: Graph): Problem[] {
  const value = node.data.step.variable;
  return maybeProblem(
    node,
    graph,
    'error',
    'Use a variable name like order_id',
    'variable',
    blank(value) || !VARIABLE_PATTERN.test(String(value))
  );
}

function agentStepProblems(node: NodeOfKind<'flow'>, graph: Graph): Problem[] {
  return maybeProblem(node, graph, 'error', 'Pick the agent to run', 'agent', blank(node.data.step.agent));
}

function approvalProblems(node: NodeOfKind<'flow'>, graph: Graph): Problem[] {
  return maybeProblem(node, graph, 'error', 'Write what the person approves', 'message', blank(node.data.step.message));
}

/** The type-specific checks; types without a row produce no problems. */
const TYPE_PROBLEMS: Record<string, (node: NodeOfKind<'flow'>, graph: Graph) => Problem[]> = {
  sequence: containerProblems,
  parallel: containerProblems,
  oneOf: routerProblems,
  forEach: loopProblems,
  llmCall: llmCallProblems,
  toolCall: toolCallProblems,
  setVariable: variableProblems,
  agent: agentStepProblems,
  approval: approvalProblems,
};

/** The type-specific rows of `flowRules.validate`; each returns its problems. */
function typeProblems(node: NodeOfKind<'flow'>, graph: Graph): Problem[] {
  const step = node.data.step;
  const type = String(step.type);
  if (!RUNNABLE_TYPES.has(type)) {
    return [flowProblem(node, graph, 'error', 'This step type cannot run', 'type')];
  }
  const problems = TYPE_PROBLEMS[type]?.(node, graph) ?? [];
  const outputVariable = step.outputVariable;
  if (
    typeof outputVariable === 'string' &&
    outputVariable !== '' &&
    !VARIABLE_PATTERN.test(outputVariable)
  ) {
    problems.push(flowProblem(node, graph, 'error', 'Use a variable name like order_id', 'outputVariable'));
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
 * Moves `childId` `delta` places inside `parentId`'s ordered children
 * (`steps` ids or router `options`; `delta` is -1 up / +1 down). A no-op at
 * either end, for `step`-shaped (single-child) parents, and for children
 * the parent does not reference. C25's container Inspector uses it for the
 * Up/Down buttons.
 */
export function reorderChild(graph: Graph, parentId: string, childId: string, delta: number): Graph {
  return mapFlowData(graph, parentId, (data) => {
    const children = effectiveChildren(data);
    if (children.shape === 'steps') {
      const from = children.ids.indexOf(childId);
      const to = from + delta;
      if (from === -1 || to < 0 || to >= children.ids.length) return undefined;
      const ids = [...children.ids];
      ids.splice(from, 1);
      ids.splice(to, 0, childId);
      return { ...data, children: { shape: 'steps', ids } };
    }
    if (children.shape === 'options') {
      const from = children.options.findIndex((o) => o.id === childId);
      const to = from + delta;
      if (from === -1 || to < 0 || to >= children.options.length) return undefined;
      const options = [...children.options];
      const [moved] = options.splice(from, 1);
      options.splice(to, 0, moved);
      return { ...data, children: { shape: 'options', options } };
    }
    return undefined;
  });
}

/**
 * Sets a router option's `condition` (`trimmed`; empty removes it — the
 * option becomes the default branch). C25's condition editor calls this.
 */
export function setOptionCondition(graph: Graph, routerId: string, childId: string, condition: string): Graph {
  const trimmed = condition.trim();
  return mapFlowData(graph, routerId, (data) => {
    if (data.children.shape !== 'options') return undefined;
    const options = data.children.options.map((option) => {
      if (option.id !== childId) return option;
      if (trimmed === '') {
        return { id: option.id };
      }
      return { ...option, condition: trimmed };
    });
    return { ...data, children: { shape: 'options', options } };
  });
}
