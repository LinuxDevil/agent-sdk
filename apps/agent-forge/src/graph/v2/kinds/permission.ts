/**
 * `KindRules` for `permission` nodes — every `spec.permissions` entry
 * (`PermissionRuleSpec`). `validate` checks the tool list, the `when`
 * matcher operands and the `ttlMs`/action pairing, and warns when no tool
 * or MCP node of the same agent matches the rule. `addToolToRule` is the
 * shared connect effect the `tool → permission` and `mcp → permission`
 * edges use (`toolRules`/`mcpRules` call it from `connectFrom`), and
 * `duplicateData` gives the copy the next free `p<n>` item id.
 */
import type { ConnectResult, KindRules } from '../kindRules';
import { ruleCoversServer, ruleCoversTool } from '../edges';
import { nextItemId, toolNodeName } from '../nodeIds';
import { arrayItemSpecPath, sectionChildren } from '../order';
import { SPEC_ID_PATTERN } from '../specTypes';
import type {
  Graph,
  GraphNode,
  McpNodeData,
  NodeOfKind,
  PermissionNodeData,
  Problem,
  ToolNodeData,
} from '../types';

/**
 * The `item.id` rule the Inspector and the validator share — the SDK's
 * `specIdSchema` pattern (`SPEC_ID_PATTERN`), re-exported through
 * `specTypes`, so the canvas flags exactly the ids a spec cannot carry.
 */
export const PERMISSION_ID_PATTERN = SPEC_ID_PATTERN;

/**
 * Every permission rule's `item.id` — the `taken` set for
 * `nextItemId('p', …)` when the palette entry or a duplicate names a new
 * rule (rule ids are unique across the whole graph, per the
 * `duplicateItemIds` core check).
 */
export function allPermissionIds(graph: Graph): string[] {
  return graph.nodes
    .filter((n) => n.kind === 'permission')
    .map((n) => (n.data as PermissionNodeData).item.id);
}

/** `pattern` compiles as a regular expression. */
function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `tool → permission` / `mcp → permission` connect effect: appends
 * `name` to the rule's `item.tool`, keeping the string/array shape
 * (a string grows into `[old, new]`, an empty value becomes the single
 * `name`). `name` is the tool node name for a tool source or
 * `<mcp key>__*` for an MCP source; the `__*` suffix marks the server
 * form, so the coverage check and the refusal label (`<key>`, not
 * `<key>__*`) fall out of one signature. Refuses when a pattern already
 * covers the tool (`This rule already covers <name>`) or the server
 * (`This rule already covers <key>` — `*` or any `<key>__` pattern,
 * including the single-tool `<key>__<tool>` rules C07 writes).
 */
export function addToolToRule(graph: Graph, ruleId: string, name: string): ConnectResult {
  const rule = graph.nodes.find((n) => n.id === ruleId);
  if (rule === undefined || rule.kind !== 'permission') {
    return { ok: false, reason: `Unknown permission rule '${ruleId}'` };
  }
  const { item } = rule.data as PermissionNodeData;
  const patterns = [item.tool].flat();
  const serverKey = name.endsWith('__*') ? name.slice(0, -3) : undefined;
  const covered =
    serverKey !== undefined
      ? ruleCoversServer(patterns, serverKey)
      : ruleCoversTool(patterns, name);
  if (covered) return { ok: false, reason: `This rule already covers ${serverKey ?? name}` };
  const tool = patterns.every((p) => p === '') ? name : [...patterns, name];
  return {
    ok: true,
    graph: {
      ...graph,
      nodes: graph.nodes.map(
        (n) => (n.id === ruleId ? { ...n, data: { item: { ...item, tool } } } : n) as GraphNode,
      ),
    },
  };
}

/** The 'tool' problems: at least one name or pattern, and a sibling it governs. */
function toolProblems(node: NodeOfKind<'permission'>, graph: Graph, path: string): Problem[] {
  const { item } = node.data;
  const patterns = [item.tool].flat();
  const fail = (severity: Problem['severity'], message: string): Problem => ({
    nodeId: node.id,
    severity,
    message,
    fieldPath: `${path}.tool`,
  });
  const problems: Problem[] = [];
  if (patterns.every((p) => typeof p !== 'string' || p.trim() === '')) {
    problems.push(fail('error', 'Add at least one tool name or pattern'));
  }
  const governs = sectionChildren(graph, node.owner ?? '', 'tools')
    .concat(sectionChildren(graph, node.owner ?? '', 'mcpServers'))
    .some((sibling) =>
      sibling.kind === 'tool'
        ? ruleCoversTool(patterns, toolNodeName((sibling.data as ToolNodeData).item))
        : ruleCoversServer(patterns, (sibling.data as McpNodeData).key),
    );
  if (!governs) problems.push(fail('warning', 'No tool on this agent matches this rule'));
  return problems;
}

const NUMERIC_OPS = ['lt', 'lte', 'gt', 'gte'] as const;

/** The operand checks for one `when` entry: numeric operators take numbers, `matches` must compile. */
function matcherProblems(
  node: NodeOfKind<'permission'>,
  path: string,
  key: string,
  record: Record<string, unknown>,
): Problem[] {
  const problems: Problem[] = [];
  const fail = (message: string): void => {
    problems.push({
      nodeId: node.id,
      severity: 'error',
      message,
      fieldPath: `${path}.when.${key}`,
    });
  };
  for (const op of NUMERIC_OPS) {
    if (op in record && typeof record[op] !== 'number') fail(`Use a number for ${op}`);
  }
  if ('matches' in record && (typeof record.matches !== 'string' || !compiles(record.matches))) {
    fail(`The pattern for ${key} is not a valid regular expression`);
  }
  return problems;
}

/** The `when` problems: empty argument names and operand types the spec cannot carry. */
function whenProblems(node: NodeOfKind<'permission'>, path: string): Problem[] {
  const { item } = node.data;
  const problems: Problem[] = [];
  for (const [key, matcher] of Object.entries(item.when ?? {})) {
    if (key === '') {
      problems.push({
        nodeId: node.id,
        severity: 'error',
        message: 'A condition needs an argument name',
        fieldPath: `${path}.when`,
      });
      continue;
    }
    if (typeof matcher === 'object' && matcher !== null) {
      problems.push(...matcherProblems(node, path, key, matcher as Record<string, unknown>));
    }
  }
  return problems;
}

/** `ttlMs` only makes sense while the rule can pause — 'ask' and model-decided 'auto'. */
function ttlProblems(node: NodeOfKind<'permission'>, path: string): Problem[] {
  const { item } = node.data;
  if (item.ttlMs === undefined || (item.action !== 'allow' && item.action !== 'deny')) return [];
  return [
    {
      nodeId: node.id,
      severity: 'warning',
      message: 'Remembering only applies to ask and model-decided rules',
      fieldPath: `${path}.ttlMs`,
    },
  ];
}

/**
 * `permission` kind rules: validation plus the duplicate's fresh `p<n>`
 * id. `permission` has no outgoing edges (`CONNECTION_RULES.permission`
 * is empty), so there is no `connectFrom` — the connect effects that
 * target a rule live on `toolRules` and `mcpRules` and share
 * {@link addToolToRule}.
 */
export const permissionRules: KindRules<'permission'> = {
  validate: (node, graph) => {
    const path = arrayItemSpecPath(graph, node, 'permissions');
    return [
      ...toolProblems(node, graph, path),
      ...whenProblems(node, path),
      ...ttlProblems(node, path),
    ];
  },
  duplicateData: (node, graph) => ({
    item: {
      ...structuredClone(node.data.item),
      id: nextItemId('p', allPermissionIds(graph)),
    },
  }),
};
