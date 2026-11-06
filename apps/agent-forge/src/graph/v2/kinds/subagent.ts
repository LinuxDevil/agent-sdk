/**
 * `KindRules` for `subagent` nodes — the `{ ref }` and `{ remote }` entries
 * of `spec.subagents` (inline entries are `agent` nodes and keep the agent
 * rules). `validate` checks the fields the subagent Inspector edits (C04);
 * `duplicateData` rekeys the copy `<key>-copy` like the other record-keyed
 * kinds.
 */
import { uniqueName } from '../nodeIds';
import { subagentEntryKey, subagentSiblingKeys } from '../order';
import type { KindRules } from '../kindRules';
import type { Graph, GraphNode, NodeOfKind, Problem } from '../types';

/**
 * The `subagents` record-key rule the Inspector and the validator share.
 * Lower-case only, matching the inline `subagentKey` field — both kinds of
 * entry share one record, so one record-key rule covers both.
 */
export const SUBAGENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** `''` for a root-owned subagent, else the owner agent's `subagents.<key>.inline` chain plus a trailing `.`. */
function ownerPrefix(node: NodeOfKind<'subagent'>, graph: Graph): string {
  const segments: string[] = [];
  let ownerId: string | null = node.owner;
  while (ownerId !== null) {
    const owner: GraphNode | undefined = graph.nodes.find((n) => n.id === ownerId);
    // The root agent contributes no segment — only inline agents do.
    if (owner === undefined || owner.kind !== 'agent' || owner.owner === null) break;
    const key: string | undefined = subagentEntryKey(owner);
    segments.unshift(`subagents.${key ?? ''}.inline`);
    ownerId = owner.owner;
  }
  return segments.length === 0 ? '' : `${segments.join('.')}.`;
}

/** The node's spec path: `<owner prefix>subagents.<key>`. */
function subagentSpecPath(node: NodeOfKind<'subagent'>, graph: Graph): string {
  return `${ownerPrefix(node, graph)}subagents.${node.data.key}`;
}

/**
 * True when `url` parses as an absolute URL whose protocol is `https:` —
 * or whose host is localhost, the one place plain http is allowed (a
 * dev-time remote agent). Shared with the Inspector's URL field.
 */
export function remoteUrlOk(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    );
  } catch {
    return false;
  }
}

/** Trim-empty is empty: `undefined`, non-strings and whitespace-only values all count as missing. */
function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/** The required fields of `subagentRules`: a ref needs a target, a remote needs a URL and a description. */
function validateSubagent(node: NodeOfKind<'subagent'>, graph: Graph): Problem[] {
  const path = subagentSpecPath(node, graph);
  const { item } = node.data;
  const problems: Problem[] = [];
  const fail = (field: string, message: string) =>
    problems.push({ nodeId: node.id, severity: 'error', message, fieldPath: `${path}.${field}` });
  if ('ref' in item) {
    if (blank(item.ref)) fail('ref', 'Pick the agent this subagent runs');
  } else {
    if (!remoteUrlOk(item.remote.url)) fail('remote.url', 'The remote agent needs a full URL');
    if (blank(item.remote.description)) fail('remote.description', 'A remote agent needs a description');
  }
  return problems;
}

/**
 * `KindRules` for `subagent`: no `connectFrom` — `CONNECTION_RULES.subagent`
 * is empty, so a subagent is never the source of a drawn edge (incoming
 * `agent → subagent` edges take the agent's re-own effect).
 */
export const subagentRules: KindRules<'subagent'> = {
  validate: validateSubagent,
  duplicateData: (node, graph) => ({
    ...node.data,
    key: uniqueName(`${node.data.key}-copy`, subagentSiblingKeys(graph, node.owner)),
  }),
};
