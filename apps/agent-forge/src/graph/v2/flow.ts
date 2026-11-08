/**
 * The `flow` section ⇄ `flow` node tree (C15): `spec.flow` becomes one
 * `flow:<step id>` node per step under the root agent, with the step's
 * child-holding field (`steps`, `options`, `step`) moved into
 * `FlowNodeData.children` as node-id references. `graphToFlow` rebuilds the
 * exact `AgentFlow`; `flowRoot`/`flowParent`/`flowTree`/`flowSpecPaths` are
 * the shared tree walks every consumer (edges, orderedNodes, mutations,
 * validation, the card) uses. All spec types come through `./specTypes`.
 */
import { nextItemId } from './nodeIds';
import { addSpecNode, type SpecToGraphBuilder } from './specBuilder';
import type { AgentFlow } from './specTypes';
import type { FlowNodeData, Graph, GraphNode, NodeOfKind } from './types';
import { ROOT_AGENT_ID } from './types';

/** The step field that holds children, per container step type (`undefined` = leaf). */
const CHILD_FIELD: Record<string, 'steps' | 'options' | 'step' | undefined> = {
  sequence: 'steps',
  parallel: 'steps',
  oneOf: 'options',
  forEach: 'step',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every string `id` anywhere in a step tree — the `used` set missing ids are assigned against. */
function collectStepIds(step: unknown, used: Set<string>): void {
  if (!isRecord(step)) return;
  if (typeof step.id === 'string' && step.id !== '') used.add(step.id);
  const field = CHILD_FIELD[String(step.type)];
  if (field === 'steps' && Array.isArray(step.steps)) {
    for (const child of step.steps) collectStepIds(child, used);
  } else if (field === 'options' && Array.isArray(step.options)) {
    for (const option of step.options) {
      if (isRecord(option)) collectStepIds(option.step, used);
    }
  } else if (field === 'step') {
    collectStepIds(step.step, used);
  }
}

/** The step's id: its own when a non-empty string, else the next free `s<n>` (recorded in `used`). */
function stepIdOf(step: Record<string, unknown>, used: Set<string>): string {
  if (typeof step.id === 'string' && step.id !== '') return step.id;
  const id = nextItemId('s', used);
  used.add(id);
  return id;
}

/** What `addStep` extracted from a step's child field, before the child nodes exist. */
type ChildPlan =
  | { kind: 'none' }
  | { kind: 'steps'; steps: Record<string, unknown>[] }
  | { kind: 'options'; options: Array<{ condition?: string; step: Record<string, unknown> }> }
  | { kind: 'step'; step?: Record<string, unknown> };

/**
 * The child extraction for one step, all-or-nothing per field: `steps` and
 * `options` move to `children` only when every entry is a step object (a
 * malformed field stays verbatim inside `data.step` and the node gets
 * `children: { shape: 'none' }`, so nothing is lost). `forEach` always gets
 * the `step` shape — `id: null` when there is no runnable child step.
 */
function childPlan(step: Record<string, unknown>): { field?: 'steps' | 'options' | 'step'; plan: ChildPlan } {
  const type = String(step.type);
  const field = CHILD_FIELD[type];
  if (field === 'steps' && Array.isArray(step.steps) && step.steps.every(isRecord)) {
    return { field, plan: { kind: 'steps', steps: step.steps as Record<string, unknown>[] } };
  }
  if (
    field === 'options' &&
    Array.isArray(step.options) &&
    step.options.every((o) => isRecord(o) && isRecord(o.step))
  ) {
    const options = (step.options as Array<Record<string, unknown>>).map((o) => ({
      ...(o.condition !== undefined ? { condition: o.condition as string } : {}),
      step: o.step as Record<string, unknown>,
    }));
    return { field, plan: { kind: 'options', options } };
  }
  if (field === 'step') {
    const child = isRecord(step.step) ? (step.step as Record<string, unknown>) : undefined;
    // A malformed `step` value stays in `data.step` verbatim (the `step`
    // field is only removed when it became a child node).
    return { field: child === undefined ? undefined : 'step', plan: { kind: 'step', step: child } };
  }
  return { plan: { kind: 'none' } };
}

/** `step` minus its extracted child field, keys in order, `id` resolved to a string. */
function stepData(step: Record<string, unknown>, field: 'steps' | 'options' | 'step' | undefined, id: string): FlowNodeData['step'] {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(step)) {
    if (key === field) continue;
    out[key] = value;
  }
  out.id = id;
  return out as FlowNodeData['step'];
}

/**
 * One `flow` node per step, depth-first pre-order (parents before children,
 * so the node array order matches `flowTree`). Missing step ids get the
 * next free `s<n>` — the spec then changes on the next save, which is the
 * intended upgrade of id-less v1 flows.
 */
function addStep(
  builder: SpecToGraphBuilder,
  ownerId: string,
  step: Record<string, unknown>,
  used: Set<string>
): GraphNode {
  const id = stepIdOf(step, used);
  const { field, plan } = childPlan(step);
  const node = addSpecNode(
    builder,
    ownerId,
    'flow',
    { step: stepData(step, field, id), children: { shape: 'none' } } as FlowNodeData,
    false
  );
  const data = node.data as FlowNodeData;
  if (plan.kind === 'steps') {
    const ids = plan.steps.map((child) => addStep(builder, ownerId, child, used).id);
    data.children = { shape: 'steps', ids };
  } else if (plan.kind === 'options') {
    const options = plan.options.map((option) => ({
      ...(option.condition !== undefined ? { condition: option.condition } : {}),
      id: addStep(builder, ownerId, option.step, used).id,
    }));
    data.children = { shape: 'options', options };
  } else if (plan.kind === 'step') {
    data.children = { shape: 'step', id: plan.step === undefined ? null : addStep(builder, ownerId, plan.step, used).id };
  }
  return node;
}

/**
 * Adds `flow` nodes for `spec.flow` under the root agent. Returns false —
 * the caller keeps `flow` in the root agent's `extra` — when
 * `spec.flow.flow` is undefined or not a step object.
 */
export function addFlowNodes(builder: SpecToGraphBuilder, flow: AgentFlow): boolean {
  if (flow === null || typeof flow !== 'object') return false;
  const rootStep = (flow as { flow?: unknown }).flow;
  if (!isRecord(rootStep)) return false;
  const used = new Set<string>();
  collectStepIds(rootStep, used);
  const root = addStep(builder, ROOT_AGENT_ID, rootStep, used);
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flow as unknown as Record<string, unknown>)) {
    if (key !== 'flow') meta[key] = value;
  }
  (root.data as FlowNodeData).flowMeta = meta as FlowNodeData['flowMeta'];
  return true;
}

/** The child node ids of a flow node, in spec order (`steps`, `options`, `step`). */
export function flowChildIds(node: GraphNode): string[] {
  return flowChildRefs(node).map((ref) => ref.id);
}

/**
 * A flow node's children as `{ id, segment }` pairs: `id` is the child node
 * id, `segment` the path fragment locating the child inside the parent's
 * step (`steps[1]`, `options[0].step`, `step`).
 */
export function flowChildRefs(node: GraphNode): Array<{ id: string; segment: string }> {
  const children = (node.data as FlowNodeData).children;
  switch (children.shape) {
    case 'steps':
      return children.ids.map((id, i) => ({ id, segment: `steps[${i}]` }));
    case 'options':
      return children.options.map((option, i) => ({ id: option.id, segment: `options[${i}].step` }));
    case 'step':
      return children.id === null ? [] : [{ id: children.id, segment: 'step' }];
    default:
      return [];
  }
}

function liveNodes(graph: Graph): GraphNode[] {
  return graph.nodes.filter((n) => n.proposed !== 'remove');
}

/** The flow node no other flow node lists as a child — the tree's root. */
export function flowRoot(graph: Graph): NodeOfKind<'flow'> | undefined {
  const flows = liveNodes(graph).filter((n) => n.kind === 'flow');
  const referenced = new Set(flows.flatMap(flowChildIds));
  return flows.find((n) => !referenced.has(n.id)) as NodeOfKind<'flow'> | undefined;
}

/** Id of the flow node that lists `nodeId` as a child, or undefined for the root. */
export function flowParent(graph: Graph, nodeId: string): string | undefined {
  const parent = liveNodes(graph).find(
    (n) => n.kind === 'flow' && flowChildIds(n).includes(nodeId)
  );
  return parent?.id;
}

/** The live flow nodes of the tree under `flowRoot`, depth-first pre-order. Orphans are excluded. */
export function flowTree(graph: Graph): NodeOfKind<'flow'>[] {
  const root = flowRoot(graph);
  if (root === undefined) return [];
  const byId = new Map(liveNodes(graph).map((n) => [n.id, n]));
  const out: NodeOfKind<'flow'>[] = [];
  const seen = new Set<string>();
  const visit = (node: GraphNode): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    out.push(node as NodeOfKind<'flow'>);
    for (const ref of flowChildRefs(node)) {
      const child = byId.get(ref.id);
      if (child !== undefined && child.kind === 'flow') visit(child);
    }
  };
  visit(root);
  return out;
}

/** `flow:<node id>` → its spec path (`flow.flow`, `flow.flow.steps[1]`, `flow.flow.options[0].step`, …). */
export function flowSpecPaths(graph: Graph): Record<string, string> {
  const paths: Record<string, string> = {};
  const root = flowRoot(graph);
  if (root === undefined) return paths;
  const byId = new Map(liveNodes(graph).map((n) => [n.id, n]));
  const seen = new Set<string>();
  const visit = (node: GraphNode, rel: string): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    paths[node.id] = `flow.${rel}`;
    for (const ref of flowChildRefs(node)) {
      const child = byId.get(ref.id);
      if (child !== undefined && child.kind === 'flow') visit(child, `${rel}.${ref.segment}`);
    }
  };
  visit(root, 'flow');
  return paths;
}

/** The spec path of one flow node (`flow.flow.steps[1]`), or undefined when it is not in the tree. */
export function flowSpecPath(graph: Graph, nodeId: string): string | undefined {
  return flowSpecPaths(graph)[nodeId];
}

/** AgentFlow key order when there is no `previous`: `flow` sits before `agents`, per the SDK type. */
const FLOW_KEY_ORDER = ['id', 'code', 'name', 'description', 'inputs', 'flow', 'agents'] as const;

/**
 * Rebuilds the `AgentFlow` from the flow nodes: `{ ...flowMeta, flow: build(root) }`.
 * `build(node)` = `{ ...data.step, <childField>: … }` — the child field is
 * appended last, the only YAML reordering the canvas is allowed to make.
 * `proposed: 'remove'` and dangling children are skipped as if absent.
 */
export function graphToFlow(graph: Graph, previous?: AgentFlow): AgentFlow | undefined {
  const root = flowRoot(graph);
  if (root === undefined) return undefined;
  const byId = new Map(liveNodes(graph).map((n) => [n.id, n]));
  const child = (id: string | null): GraphNode | undefined => {
    if (id === null) return undefined;
    const node = byId.get(id);
    return node !== undefined && node.kind === 'flow' ? node : undefined;
  };
  const build = (node: GraphNode): Record<string, unknown> => {
    const { step, children } = node.data as FlowNodeData;
    const base = { ...step };
    if (children.shape === 'steps') {
      const steps = children.ids
        .map((id) => child(id))
        .filter((n): n is GraphNode => n !== undefined)
        .map(build);
      return { ...base, steps };
    }
    if (children.shape === 'options') {
      const options: Array<{ condition?: string; step: Record<string, unknown> }> = [];
      for (const option of children.options) {
        const node = child(option.id);
        if (node === undefined) continue;
        options.push({
          ...(option.condition !== undefined ? { condition: option.condition } : {}),
          step: build(node),
        });
      }
      return { ...base, options };
    }
    if (children.shape === 'step') {
      const inner = child(children.id);
      return inner === undefined ? base : { ...base, step: build(inner) };
    }
    return base;
  };
  const meta = { ...(root.data as FlowNodeData).flowMeta } as Record<string, unknown>;
  const flowValue = build(root);
  // Key order mirrors `orderKeys`: `previous`'s order first — with `flow` at
  // the position it had there — then the canonical list, then the rest. This
  // is what keeps a no-edit round trip byte-identical.
  const prev = previous as unknown as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = {};
  const emit = (key: string): void => {
    if (key in out) return;
    out[key] = key === 'flow' ? flowValue : meta[key];
  };
  for (const key of prev === undefined ? [] : Object.keys(prev)) {
    if (key === 'flow' || key in meta) emit(key);
  }
  for (const key of FLOW_KEY_ORDER) {
    if (key === 'flow' || key in meta) emit(key);
  }
  for (const key of Object.keys(meta)) emit(key);
  return out as unknown as AgentFlow;
}

/** `node` with `childId` detached from its `FlowChildren` (options drop the entry, a forEach step becomes null). */
export function removeFlowChild(node: GraphNode, childId: string): GraphNode {
  if (node.kind !== 'flow') return node;
  const flowNode = node as NodeOfKind<'flow'>;
  const data = flowNode.data;
  const children = data.children;
  if (children.shape === 'steps') {
    return { ...flowNode, data: { ...data, children: { shape: 'steps', ids: children.ids.filter((id) => id !== childId) } } };
  }
  if (children.shape === 'options') {
    return {
      ...flowNode,
      data: {
        ...data,
        children: { shape: 'options', options: children.options.filter((o) => o.id !== childId) },
      },
    };
  }
  if (children.shape === 'step' && children.id === childId) {
    return { ...flowNode, data: { ...data, children: { shape: 'step', id: null } } };
  }
  return node;
}
