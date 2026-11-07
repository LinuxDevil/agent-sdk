/**
 * `KindRules` for `agent` nodes. `connectFrom` is the default attach
 * effect: drawing agent → capability re-owns the capability to that agent.
 * `validate` checks the fields the agent Inspector edits (C03);
 * `duplicateData` arrives with the subagent group ticket (C04).
 */
import type { ConnectResult, KindRules } from '../kindRules';
import { uniqueName } from '../nodeIds';
import { outputUnavailableReason } from './output';
import { subagentSiblingKeys } from '../order';
import { reownNode } from '../reown';
import type { AgentNodeData, Graph, GraphNode, NodeOfKind, Problem } from '../types';
import { ROOT_AGENT_ID } from '../types';

/** The spec `name` rule: 1-64 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit. */
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
/** The `model` rule the inspector and the validator share: 'provider/model'. */
export const AGENT_MODEL_PATTERN = /^[^/\s]+\/\S+$/;

/** `''` for the root, else the `subagents.<key>.inline` chain of an inline agent, built from the owner chain. */
function agentSpecPath(node: NodeOfKind<'agent'>, graph: Graph): string {
  const segments: string[] = [];
  let current: NodeOfKind<'agent'> | undefined = node;
  while (current !== undefined && current.owner !== null) {
    segments.unshift(`subagents.${current.data.subagentKey ?? ''}.inline`);
    const parent: GraphNode | undefined = graph.nodes.find((n) => n.id === current!.owner);
    current = parent !== undefined && parent.kind === 'agent' ? parent : undefined;
  }
  return segments.join('.');
}

/** Trim-empty is empty: `undefined`, non-strings and whitespace-only values all count as missing. */
function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/** `instructions` is present only as a non-empty string or a `{ file }` with a non-empty path. */
function instructionsMissing(instructions: AgentNodeData['fields']['instructions']): boolean {
  if (instructions === undefined || instructions === null) return true;
  if (typeof instructions === 'string') return instructions.trim() === '';
  return typeof instructions.file !== 'string' || instructions.file.trim() === '';
}

/**
 * The agent fields the Inspector edits: name, model, instructions, and —
 * for an inline subagent — description. `fieldPath` is the agent's spec
 * path (`''` root, `subagents.<key>.inline` inline) plus the field name.
 */
function validateAgent(node: NodeOfKind<'agent'>, graph: Graph): Problem[] {
  const base = agentSpecPath(node, graph);
  const { fields } = node.data;
  const problems: Problem[] = [];
  const fail = (field: string, message: string) =>
    problems.push({
      nodeId: node.id,
      severity: 'error',
      message,
      fieldPath: base === '' ? field : `${base}.${field}`,
    });
  if (blank(fields.name)) fail('name', 'The agent needs a name');
  else if (!AGENT_NAME_PATTERN.test(fields.name)) {
    fail('name', 'The name can use letters, digits, space, dot, dash or underscore');
  }
  if (blank(fields.model) || !AGENT_MODEL_PATTERN.test(fields.model)) fail('model', 'Pick a model');
  if (instructionsMissing(fields.instructions)) fail('instructions', 'The agent needs instructions');
  if (node.data.subagentKey !== undefined && blank(fields.description)) {
    fail('description', 'A subagent needs a description');
  }
  return problems;
}

/** How deep `node` sits in the inline-agent chain: an immediate subagent of the root is depth 1. */
function inlineDepth(node: NodeOfKind<'agent'>, graph: Graph): number {
  let depth = 0;
  let current: NodeOfKind<'agent'> | undefined = node;
  while (current !== undefined && current.owner !== null) {
    depth += 1;
    const parent: GraphNode | undefined = graph.nodes.find((n) => n.id === current!.owner);
    current = parent !== undefined && parent.kind === 'agent' ? parent : undefined;
  }
  return depth;
}

/** The root agent's `maxSubagentDepth` (the SDK's runtime default is 1: sub-agents get no `task` tool). */
function maxSubagentDepth(graph: Graph): number {
  const root = graph.nodes.find((n) => n.id === ROOT_AGENT_ID && n.kind === 'agent');
  const max = root === undefined ? undefined : (root.data as AgentNodeData).fields.maxSubagentDepth;
  return typeof max === 'number' ? max : 1;
}

/** An inline agent deeper than the root's `maxSubagentDepth` can never run — warn, don't block. */
function depthWarning(node: NodeOfKind<'agent'>, graph: Graph): Problem[] {
  if (node.data.subagentKey === undefined) return [];
  const max = maxSubagentDepth(graph);
  if (inlineDepth(node, graph) <= max) return [];
  return [
    {
      nodeId: node.id,
      severity: 'warning',
      message: `This subagent is deeper than the agent's max subagent depth (${max})`,
      fieldPath: agentSpecPath(node, graph),
    },
  ];
}

/** `KindRules` for `agent`: `connectFrom` re-owns the target to the source agent. */
export const agentRules: KindRules<'agent'> = {
  validate: (node, graph) => [...validateAgent(node, graph), ...depthWarning(node, graph)],
  connectFrom: (source, target: GraphNode, graph: Graph): ConnectResult => {
    // `agent → output` re-owns the schema; the one-output-per-agent rule
    // needs the graph, so it lives here rather than in `canConnect`.
    if (target.kind === 'output') {
      const taken = outputUnavailableReason(graph, source.id);
      if (taken !== undefined) return { ok: false, reason: taken };
    }
    return { ok: true, graph: reownNode(graph, target.id, source.id) };
  },
  // Duplicating an inline agent copies the node only (never its children);
  // its `subagents` record key still has to be unique among siblings.
  duplicateData: (node, graph) =>
    node.data.subagentKey === undefined
      ? structuredClone(node.data)
      : {
          ...node.data,
          subagentKey: uniqueName(`${node.data.subagentKey}-copy`, subagentSiblingKeys(graph, node.owner)),
        },
};
