/**
 * `KindRules` for `agent` nodes. `connectFrom` is the default attach
 * effect: drawing agent → capability re-owns the capability to that agent.
 * `validate` checks the fields the agent Inspector edits (C03);
 * `duplicateData` arrives with the subagent group ticket (C04).
 */
import type { ConnectResult, KindRules } from '../kindRules';
import { reownNode } from '../reown';
import type { AgentNodeData, Graph, GraphNode, NodeOfKind, Problem } from '../types';

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

/** `KindRules` for `agent`: `connectFrom` re-owns the target to the source agent. */
export const agentRules: KindRules<'agent'> = {
  validate: validateAgent,
  connectFrom: (source, target: GraphNode, graph: Graph): ConnectResult => ({
    ok: true,
    graph: reownNode(graph, target.id, source.id),
  }),
};
