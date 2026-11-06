/**
 * Canonical ordering for the spec ⇄ graph conversion: the declaration order
 * spec keys are emitted in (`SPEC_KEY_ORDER`), which spec sections become
 * capability nodes (`HANDLED_SECTIONS`), stable key reordering for emitted
 * specs (`orderKeys`) and the single definition of node walk order
 * (`orderedNodes`) that `specToGraph`'s push order, `graphToSpec`'s
 * `nodeIdMap` and every consumer share.
 */
import type { AgentNodeData, Graph, GraphNode, SectionKey, SubagentNodeData } from './types';
import { ROOT_AGENT_ID, SECTION_KIND, SECTION_ORDER } from './types';

/** PLAN §3.1 declaration order. Emission order when there is no previousSpec. */
export const SPEC_KEY_ORDER: readonly string[] = [
  'version', 'name', 'description', 'model', 'fallbackModels', 'instructions', 'instructionsByFamily', 'promptRef',
  'modelSettings', 'reasoning', 'tools', 'mcpServers', 'skills', 'memory', 'subagents', 'subagentOptions',
  'maxSubagentDepth', 'handoffs', 'maxHandoffs', 'guardrails', 'permissions', 'permissionMode', 'approvalTtlMs',
  'askQuestion', 'hooks', 'output', 'limits', 'maxSteps', 'compaction', 'retry', 'rateLimit', 'promptCaching',
  'toolSearch', 'codeMode', 'triggers', 'abortListeners', 'flow', 'evals',
];

/** Sections specToGraph turns into nodes. C15 adds 'flow'. Anything else lands in AgentNodeData.extra. */
export const HANDLED_SECTIONS: ReadonlySet<SectionKey> = new Set(
  SECTION_ORDER.filter((key) => key !== 'flow')
);

/**
 * Keys of `obj` reordered: keys present in `previous` first in previous's
 * order, then `SPEC_KEY_ORDER`, then the rest in obj's order. Used by
 * `graphToSpec` so a re-emitted spec keeps the key order of the spec it was
 * built from — or falls back to the canonical declaration order.
 */
export function orderKeys<T extends Record<string, unknown>>(obj: T, previous?: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  if (previous !== undefined) {
    for (const key of Object.keys(previous)) {
      if (key in obj) out[key] = obj[key];
    }
  }
  for (const key of SPEC_KEY_ORDER) {
    if (key in obj && !(key in out)) out[key] = obj[key];
  }
  for (const key of Object.keys(obj)) {
    if (!(key in out)) out[key] = obj[key];
  }
  return out as T;
}

/** Whether `node` is a member of section `key`: `subagents` holds `subagent` ref/remote nodes and inline `agent` nodes. */
function isSectionNode(node: GraphNode, key: SectionKey): boolean {
  if (key === 'subagents') return node.kind === 'subagent' || node.kind === 'agent';
  return node.kind === SECTION_KIND[key];
}

/**
 * The `subagents` record key a node stands for: `data.key` for a ref/remote
 * `subagent` node, `data.subagentKey` for an inline `agent` node,
 * `undefined` for anything else (and for the root agent).
 */
export function subagentEntryKey(node: GraphNode): string | undefined {
  if (node.kind === 'subagent') return (node.data as SubagentNodeData).key;
  if (node.kind === 'agent' && node.owner !== null) return (node.data as AgentNodeData).subagentKey;
  return undefined;
}

/**
 * The `subagents` record keys already taken under `ownerId` — the `taken`
 * set for `uniqueName` when a palette entry or a duplicate names a new
 * subagent (both ref/remote nodes and inline agents share the record).
 */
export function subagentSiblingKeys(graph: Graph, ownerId: string | null): string[] {
  return graph.nodes
    .filter((n) => n.owner === ownerId && n.proposed !== 'remove')
    .map((n) => subagentEntryKey(n))
    .filter((key): key is string => key !== undefined);
}

/**
 * The live (not `note`, not `proposed: 'remove'`) nodes of section `key`
 * owned by `ownerId`, in node-array order — the same membership rule
 * `orderedNodes` and `graphToSpec` share.
 */
export function sectionChildren(graph: Graph, ownerId: string, key: SectionKey): GraphNode[] {
  return graph.nodes.filter(
    (node) => node.owner === ownerId && node.proposed !== 'remove' && isSectionNode(node, key)
  );
}

/**
 * Canonical walk: the root agent, then for each owner its sections in
 * `SECTION_ORDER`, items in node-array order, recursing into an inline
 * subagent right after it. Notes and `proposed: 'remove'` nodes are
 * excluded — a marked node is not part of the spec — and so is any subtree
 * under one. `specToGraph` pushes nodes in exactly this order, which is
 * what makes `graphToSpec`'s index-zip `nodeIdMap` correct.
 */
export function orderedNodes(graph: Graph): GraphNode[] {
  const result: GraphNode[] = [];
  const emit = (ownerId: string) => {
    for (const key of SECTION_ORDER) {
      if (!HANDLED_SECTIONS.has(key)) continue;
      for (const child of sectionChildren(graph, ownerId, key)) {
        result.push(child);
        if (child.kind === 'agent') emit(child.id);
      }
    }
  };
  const root = graph.nodes.find(
    (n) => n.id === ROOT_AGENT_ID && n.kind === 'agent' && n.owner === null && n.proposed !== 'remove'
  );
  if (root !== undefined) {
    result.push(root);
    emit(root.id);
  }
  return result;
}
