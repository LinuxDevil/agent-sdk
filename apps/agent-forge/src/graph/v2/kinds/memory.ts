/**
 * `KindRules` for `memory` nodes — every `spec.memory` entry (`MemorySpec`).
 * `validate` checks the slot name (the `remember_<name>`/`recall_<name>`/
 * `forget_<name>` tool names derive from it), the metadata-key scope, the
 * provider's required fields and the `itemKey`/`itemJsonSchema` pairing, and
 * warns that a global in-memory slot loses its items on restart. No
 * `connectFrom`: an incoming `agent → memory` edge takes the default re-own
 * effect. `duplicateData` gives the copy a fresh `<name>-copy` slot name so
 * its tools do not collide with the original's.
 */
import { uniqueName } from '../nodeIds';
import { arrayItemSpecPath } from '../order';
import type { KindRules } from '../kindRules';
import type { Graph, MemoryNodeData, NodeOfKind, Problem } from '../types';

/**
 * The slot-name rule the Inspector and the validator share — the SDK's
 * `defineMemory` name pattern (`^[A-Za-z0-9_-]{1,55}$`), so the canvas flags
 * exactly the names a spec cannot carry.
 */
export const MEMORY_NAME_PATTERN = /^[A-Za-z0-9_-]{1,55}$/;

/**
 * The `item.name`s of the memory slots already owned by `ownerId` — the
 * `taken` set for `uniqueName` when the palette entry or a duplicate names a
 * new slot (slot names are unique per agent: the spec schema rejects a
 * repeated name, and `validateGraph`'s duplicate-name core check flags it).
 */
export function memorySiblingNames(graph: Graph, ownerId: string | null): string[] {
  return graph.nodes
    .filter((n) => n.owner === ownerId && n.kind === 'memory' && n.proposed !== 'remove')
    .map((n) => (n.data as MemoryNodeData).item.name);
}

/** Trim-empty is empty: `undefined`, non-strings and whitespace-only values all count as missing. */
function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/** The `MemorySpec` form's validation rows, in the ticket's order. */
function memoryProblems(node: NodeOfKind<'memory'>, path: string): Problem[] {
  const { item } = node.data;
  const problems: Problem[] = [];
  const fail = (severity: Problem['severity'], field: string, message: string): void => {
    problems.push({ nodeId: node.id, severity, message, fieldPath: `${path}.${field}` });
  };
  if (!MEMORY_NAME_PATTERN.test(item.name)) {
    fail('error', 'name', 'The memory name can use letters, digits, dash or underscore');
  }
  if (typeof item.scope === 'object' && blank(item.scope.metadataKey)) {
    fail('error', 'scope.metadataKey', 'Enter the metadata key');
  }
  if (item.provider.type === 'file' && blank(item.provider.dir)) {
    fail('error', 'provider.dir', 'Enter the folder for memory files');
  }
  if (item.provider.type === 'sqlite-vector' && blank(item.provider.embedder)) {
    fail('error', 'provider.embedder', 'Pick an embedding model');
  }
  if (item.itemKey !== undefined && item.itemJsonSchema === undefined) {
    fail('warning', 'itemKey', 'An item key needs an item schema');
  }
  if (item.provider.type === 'in-memory' && item.scope === 'global') {
    fail('warning', 'provider', 'In-memory items are lost when Studio restarts');
  }
  return problems;
}

/**
 * `memory` kind rules: validation plus the duplicate naming rule — the
 * connect effect is the default re-own attach.
 */
export const memoryRules: KindRules<'memory'> = {
  validate: (node, graph) => memoryProblems(node, arrayItemSpecPath(graph, node, 'memory')),
  duplicateData: (node, graph) => ({
    item: {
      ...structuredClone(node.data.item),
      name: uniqueName(`${node.data.item.name}-copy`, memorySiblingNames(graph, node.owner)),
    },
  }),
};
