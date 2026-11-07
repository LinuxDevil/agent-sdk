/**
 * `KindRules` for `mcp` nodes — every `spec.mcpServers` entry (stdio
 * `command` or HTTP `url`). `validate` checks the transport's required
 * field, the record key, the OAuth pairing rules and warns on a
 * secret-sounding `env`/`headers` value written as a plain string.
 * `connectFrom` implements the `mcp → permission` edge: it adds the
 * server's `<key>__*` glob to the rule's `item.tool`. An incoming
 * `agent → mcp` edge takes the agent's own re-own effect.
 */
import { uniqueName } from '../nodeIds';
import { mcpSiblingKeys, ownerSpecPrefix } from '../order';
import { MCP_SERVER_NAME } from '../specTypes';
import type { ConnectResult, KindRules } from '../kindRules';
import type { Graph, GraphNode, NodeOfKind, Problem } from '../types';
import { addToolToRule } from './permission';
import { fullUrlOk } from './tool';

/**
 * The `mcpServers` record-key rule the Inspector and the validator share —
 * the SDK's `MCP_SERVER_NAME` pattern (server names prefix their tools as
 * `<key>__<tool>`), re-exported through `specTypes` so the canvas flags
 * exactly the keys a spec cannot carry.
 */
export const MCP_KEY_PATTERN = MCP_SERVER_NAME;

/** Keys whose plain-string values should be secrets instead. */
const SECRET_SOUNDS = /token|key|secret|password|authorization/i;

/** Trim-empty is empty: `undefined`, non-strings and whitespace-only values all count as missing. */
function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/** The node's spec path: `<owner prefix>mcpServers.<key>`. */
function mcpSpecPath(node: NodeOfKind<'mcp'>, graph: Graph): string {
  return `${ownerSpecPrefix(node.owner, graph)}mcpServers.${node.data.key}`;
}

/** The transport's required-field errors. */
function transportProblems(node: NodeOfKind<'mcp'>, path: string): Problem[] {
  const { item } = node.data;
  if ('command' in item) {
    return blank(item.command)
      ? [
          {
            nodeId: node.id,
            severity: 'error',
            message: 'Enter the command that starts the server',
            fieldPath: `${path}.command`,
          },
        ]
      : [];
  }
  return fullUrlOk(item.url)
    ? []
    : [{ nodeId: node.id, severity: 'error', message: 'Enter the server URL', fieldPath: `${path}.url` }];
}

/** The record-key error: the key fails `MCP_KEY_PATTERN`. */
function keyProblems(node: NodeOfKind<'mcp'>, path: string): Problem[] {
  return MCP_KEY_PATTERN.test(node.data.key)
    ? []
    : [
        {
          nodeId: node.id,
          severity: 'error',
          message: 'The server name can use letters, digits, dash or underscore',
          fieldPath: path,
        },
      ];
}

/** The OAuth pairing rules: a client secret needs a client id, and OAuth needs a redirect URI. */
function oauthProblems(node: NodeOfKind<'mcp'>, path: string): Problem[] {
  const { item } = node.data;
  if (!('oauth' in item) || item.oauth === undefined) return [];
  const problems: Problem[] = [];
  const fail = (field: string, message: string): void => {
    problems.push({ nodeId: node.id, severity: 'error', message, fieldPath: `${path}.oauth.${field}` });
  };
  if (item.oauth.clientSecret !== undefined && blank(item.oauth.clientId)) {
    fail('clientSecret', 'Set the client id before the client secret');
  }
  if (blank(item.oauth.redirectUri)) fail('redirectUri', 'OAuth needs a redirect URI');
  return problems;
}

/** 'Store this value as a secret' for each plain-string value under a secret-sounding key of `map`. */
function secretValueProblems(
  node: NodeOfKind<'mcp'>,
  path: string,
  field: 'env' | 'headers',
  map: Record<string, unknown> | undefined,
): Problem[] {
  return Object.entries(map ?? {})
    .filter(([key, value]) => typeof value === 'string' && SECRET_SOUNDS.test(key))
    .map(([key]) => ({
      nodeId: node.id,
      severity: 'warning' as const,
      message: 'Store this value as a secret',
      fieldPath: `${path}.${field}.${key}`,
    }));
}

/** The plain-string warnings for `env` (stdio) and `headers` (http). */
function secretProblems(node: NodeOfKind<'mcp'>, path: string): Problem[] {
  const { item } = node.data;
  if ('command' in item) return secretValueProblems(node, path, 'env', item.env);
  return secretValueProblems(node, path, 'headers', item.headers);
}

/**
 * `KindRules` for `mcp`: validation, the `mcp → permission` connect
 * effect and `duplicateData`, which rekeys the copy `<key>-copy` like the
 * other record-keyed kinds.
 */
export const mcpRules: KindRules<'mcp'> = {
  validate: (node, graph) => {
    const path = mcpSpecPath(node, graph);
    return [
      ...transportProblems(node, path),
      ...keyProblems(node, path),
      ...oauthProblems(node, path),
      ...secretProblems(node, path),
    ];
  },
  /**
   * The `mcp → permission` connect effect — the only target
   * `CONNECTION_RULES.mcp` allows — adds `<key>__*` to the rule's
   * `item.tool` via `addToolToRule`.
   */
  connectFrom: (source, target: GraphNode, graph: Graph): ConnectResult =>
    target.kind === 'permission'
      ? addToolToRule(graph, target.id, `${source.data.key}__*`)
      : { ok: true, graph },
  duplicateData: (node, graph) => ({
    ...node.data,
    key: uniqueName(`${node.data.key}-copy`, mcpSiblingKeys(graph, node.owner)),
  }),
};
