/**
 * `KindRules` for `tool` nodes — every `spec.tools` entry (`ToolRef`).
 * `validate` checks the form's required field (a built-in name, a registry
 * name, a `.ts`/`.js` path inside the agent folder, integration
 * credentials, an OpenAPI document URL, a hosted tool name), the optional
 * `id` pattern, and warns on a duplicated tool name and on a secret
 * credential written as a plain string. No `connectFrom`: an incoming
 * `agent → tool` edge takes the default re-own effect.
 */
import { toolNodeName } from '../nodeIds';
import { arrayItemSpecPath, sectionChildren } from '../order';
import { SECRET_CREDENTIALS, SPEC_ID_PATTERN } from '../specTypes';
import type { KindRules } from '../kindRules';
import type { Graph, NodeOfKind, Problem, ToolNodeData } from '../types';

/**
 * The `item.id` rule the Inspector and the validator share — the SDK's
 * `specIdSchema` pattern (`SPEC_ID_PATTERN`), re-exported through
 * `specTypes`, so the canvas flags exactly the ids a spec cannot carry.
 */
export const TOOL_NODE_ID_PATTERN = SPEC_ID_PATTERN;

const FILE_ERROR = 'Use a .ts or .js file inside the agent folder';

/** Trim-empty is empty: `undefined`, non-strings and whitespace-only values all count as missing. */
function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * The `{ file }` rule the Inspector and the validator share: a relative
 * forward-slash path that stays inside the agent folder (no absolute
 * path, drive letter, backslash or `..` segment) and ends in `.ts`/`.js`.
 */
export function toolFilePathOk(path: string): boolean {
  if (path === '' || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) return false;
  if (path.split('/').includes('..')) return false;
  return /\.(ts|js)$/.test(path);
}

/** `url` parses as an absolute URL (a scheme plus a host) — the OpenAPI document address. */
export function fullUrlOk(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol !== '' && parsed.host !== '';
  } catch {
    return false;
  }
}

/** The form's required-field errors, in the ticket's order. */
function formProblems(node: NodeOfKind<'tool'>, path: string): Problem[] {
  const { item } = node.data;
  const fail = (field: string, message: string): Problem => ({
    nodeId: node.id,
    severity: 'error',
    message,
    fieldPath: `${path}.${field}`,
  });
  if ('builtin' in item) {
    return blank(item.builtin) ? [fail('builtin', 'Pick a tool')] : [];
  }
  if ('registry' in item) {
    return blank(item.registry) ? [fail('registry', 'Enter the registry item name')] : [];
  }
  if ('file' in item) {
    return toolFilePathOk(item.file) ? [] : [fail('file', FILE_ERROR)];
  }
  if ('integration' in item) {
    return Object.keys(item.credentials ?? {}).length === 0
      ? [fail('credentials', 'Add the credentials this integration needs')]
      : [];
  }
  if ('openapi' in item) {
    return fullUrlOk(item.openapi.url) ? [] : [fail('openapi.url', 'Enter the OpenAPI document URL')];
  }
  if ('hosted' in item) {
    return blank(item.hosted) ? [fail('hosted', 'Pick a provider-hosted tool')] : [];
  }
  return [];
}

/** The `id` error: set but not a spec id. */
function idProblems(node: NodeOfKind<'tool'>, path: string): Problem[] {
  const { item } = node.data;
  if (item.id === undefined || TOOL_NODE_ID_PATTERN.test(item.id)) return [];
  return [
    {
      nodeId: node.id,
      severity: 'error',
      message: 'The node id can use letters, digits, dash or underscore',
      fieldPath: `${path}.id`,
    },
  ];
}

/**
 * 'This tool is added twice' when the node's un-named siblings share its
 * `toolNodeName` — an `id` disambiguates a deliberate repeat, so only
 * id-less nodes are counted.
 */
function duplicateProblems(node: NodeOfKind<'tool'>, graph: Graph, path: string): Problem[] {
  const { item } = node.data;
  if (item.id !== undefined) return [];
  const name = toolNodeName(item);
  const twins = sectionChildren(graph, node.owner ?? '', 'tools').filter(
    (sibling) =>
      sibling.kind === 'tool' &&
      (sibling.data as ToolNodeData).item.id === undefined &&
      toolNodeName((sibling.data as ToolNodeData).item) === name
  );
  return twins.length < 2
    ? []
    : [{ nodeId: node.id, severity: 'warning', message: 'This tool is added twice', fieldPath: path }];
}

/** 'Store this credential as a secret' for each plain-string value under a `SECRET_CREDENTIALS` key. */
function secretProblems(node: NodeOfKind<'tool'>, path: string): Problem[] {
  const { item } = node.data;
  if (!('integration' in item)) return [];
  const secretKeys: readonly string[] = SECRET_CREDENTIALS[item.integration];
  return Object.entries(item.credentials ?? {})
    .filter(([key, value]) => typeof value === 'string' && secretKeys.includes(key))
    .map(([key]) => ({
      nodeId: node.id,
      severity: 'warning' as const,
      message: 'Store this credential as a secret',
      fieldPath: `${path}.credentials.${key}`,
    }));
}

/** `tool` kind rules: validation only — the connect effect is the default re-own attach. */
export const toolRules: KindRules<'tool'> = {
  validate: (node, graph) => {
    const path = arrayItemSpecPath(graph, node, 'tools');
    return [
      ...formProblems(node, path),
      ...idProblems(node, path),
      ...duplicateProblems(node, graph, path),
      ...secretProblems(node, path),
    ];
  },
};
