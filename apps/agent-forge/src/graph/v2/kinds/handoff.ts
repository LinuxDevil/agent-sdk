/**
 * `KindRules` for `handoff` nodes — the `spec.handoffs` entries. `validate`
 * checks the fields the Inspector edits: a target is required, the resolved
 * tool name (`toolName ?? transfer_to_<agent>`) must be unique among the
 * owner's handoffs, and a handoff may not name its own agent. No
 * `connectFrom` — `CONNECTION_RULES.handoff` is empty, so a handoff is
 * never the source of a drawn edge, and an incoming `agent → handoff` edge
 * takes the default re-own effect. No `duplicateData` either: the default
 * clone keeps the copy's tool-name clash visible until the user picks
 * another target, which is intended.
 */
import { ownerSpecPrefix, sectionChildren } from '../order';
import type { KindRules } from '../kindRules';
import type { AgentNodeData, Graph, HandoffNodeData, NodeOfKind, Problem } from '../types';

/**
 * The `toolName` rule the Inspector shares with the spec schema — the same
 * one defineTool() enforces (`^[a-zA-Z0-9_-]{1,64}$`).
 */
export const HANDOFF_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Trim-empty is empty: `undefined`, non-strings and whitespace-only values all count as missing. */
function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/** The node's spec path: `<owner prefix>handoffs[<index>]`. */
function handoffSpecPath(node: NodeOfKind<'handoff'>, graph: Graph): string {
  const siblings = sectionChildren(graph, node.owner ?? '', 'handoffs');
  const index = siblings.findIndex((n) => n.id === node.id);
  return `${ownerSpecPrefix(node.owner, graph)}handoffs[${index === -1 ? 0 : index}]`;
}

/** The transfer tool's resolved name — `item.toolName` or the SDK's `transfer_to_<agent>` default. */
function resolvedToolName(item: HandoffNodeData['item']): string {
  return item.toolName ?? `transfer_to_${item.agent}`;
}

/** The owner agent's own name: `fields.name` on the root, `subagentKey` on an inline agent. */
function ownerName(node: NodeOfKind<'handoff'>, graph: Graph): string | undefined {
  const owner = graph.nodes.find((n) => n.id === node.owner && n.kind === 'agent');
  if (owner === undefined) return undefined;
  const data = owner.data as AgentNodeData;
  return data.subagentKey ?? data.fields.name;
}

/**
 * Two handoffs of the same owner that resolve to the same tool name would
 * register one `transfer_to_*` tool twice — flag each of them at `toolName`.
 */
function toolNameClash(node: NodeOfKind<'handoff'>, graph: Graph): boolean {
  const name = resolvedToolName(node.data.item);
  return sectionChildren(graph, node.owner ?? '', 'handoffs').some(
    (sibling) =>
      sibling.id !== node.id &&
      sibling.kind === 'handoff' &&
      resolvedToolName((sibling.data as HandoffNodeData).item) === name,
  );
}

/** The required fields of `handoffRules`: target present, not the owner itself, tool name unique among siblings. */
function validateHandoff(node: NodeOfKind<'handoff'>, graph: Graph): Problem[] {
  const { item } = node.data;
  const fails: Array<{ field: string; message: string }> = [];
  if (blank(item.agent)) fails.push({ field: 'agent', message: 'Pick who this hands off to' });
  else if (item.agent === ownerName(node, graph)) {
    fails.push({ field: 'agent', message: 'An agent cannot hand off to itself' });
  }
  if (toolNameClash(node, graph)) {
    fails.push({
      field: 'toolName',
      message: `Two handoffs use the tool name '${resolvedToolName(item)}'`,
    });
  }
  const path = handoffSpecPath(node, graph);
  return fails.map(({ field, message }) => ({
    nodeId: node.id,
    severity: 'error',
    message,
    fieldPath: `${path}.${field}`,
  }));
}

/**
 * `KindRules` for `handoff`: validation only — the derived target edge lives
 * in `edges.ts` (`handoffTargetEdges`), and the connect effect is the
 * default re-own attach.
 */
export const handoffRules: KindRules<'handoff'> = {
  validate: validateHandoff,
};
