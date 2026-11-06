/**
 * Pure helpers for the MCP Inspector and card: the transport discriminator,
 * the keep-list a transport switch preserves (the SDK's strict spec rejects
 * stdio-only fields on http entries and vice versa, so the switch drops
 * them), the probe/readiness check and the per-tool `Allowed` toggle that
 * rewrites `item.tools`.
 */
import { fullUrlOk } from '../../../graph/v2/kinds/tool';
import type { McpServerSpec } from '../../../graph/v2/specTypes';
import type { Graph, NodeOfKind, PermissionNodeData } from '../../../graph/v2/types';

/** The stdio variant of `McpServerSpec` (the union member with `command`). */
export type McpStdioItem = Extract<McpServerSpec, { command: string }>;
/** The http variant of `McpServerSpec` (the union member with `url`). */
export type McpHttpItem = Extract<McpServerSpec, { url: string }>;
/** `item.oauth`'s type (http entries only). */
export type McpOAuthItem = NonNullable<McpHttpItem['oauth']>;

/** The two MCP transports: a local command over stdio, or a remote server over HTTP. */
export type McpTransport = 'stdio' | 'http';

/** Which transport `item` describes: `command` means stdio, anything else renders as http. */
export function transportOf(item: McpServerSpec): McpTransport {
  return 'command' in item ? 'stdio' : 'http';
}

/** The fields both transports carry — kept across a transport switch. */
const KEPT_FIELDS = ['approval', 'deferLoading', 'timeoutMs', 'connectTimeoutMs', 'tools', 'optional'] as const;

/**
 * The item a transport switch produces: the new transport's empty field
 * plus every kept field the old item carried. Stdio-only fields
 * (`command`, `args`, `env`, `cwd`, `stderr`) and http-only fields
 * (`url`, `headers`, `oauth`) are dropped — the SDK's strict
 * `McpServerSpec` validation rejects them on the wrong transport.
 */
export function switchTransport(item: McpServerSpec, to: McpTransport): McpServerSpec {
  const kept: Record<string, unknown> = {};
  const source = item as unknown as Record<string, unknown>;
  for (const field of KEPT_FIELDS) {
    if (field in source) kept[field] = source[field];
  }
  return (to === 'stdio' ? { command: '', ...kept } : { url: '', ...kept }) as McpServerSpec;
}

/** Whether the item is complete enough to probe: stdio needs a command, http a full URL. */
export function probeable(item: McpServerSpec): boolean {
  return transportOf(item) === 'stdio'
    ? (item as McpStdioItem).command.trim() !== ''
    : fullUrlOk((item as McpHttpItem).url);
}

/** The `tools` filter's shape, relaxed for reads/writes (`readonly` in the spec). */
interface ToolFilter {
  include?: readonly string[];
  exclude?: readonly string[];
}

/** Whether `name` is currently allowed: not excluded, and listed when an include list exists. */
export function isAllowed(item: McpServerSpec, name: string): boolean {
  const tools = item.tools as ToolFilter | undefined;
  if (tools?.exclude?.includes(name)) return false;
  return tools?.include === undefined || tools.include.includes(name);
}

/**
 * The `item.tools` value an `Allowed` toggle produces: unchecking adds
 * `name` to `exclude` (and drops it from `include` when an include list
 * exists); checking removes the exclusion (and re-adds it to `include`).
 * `undefined` when nothing is filtered anymore.
 */
export function toggleAllowed(
  tools: ToolFilter | undefined,
  name: string,
  allowed: boolean,
): { include?: string[]; exclude?: string[] } | undefined {
  const include = (tools?.include ?? []).filter((n) => allowed || n !== name);
  if (allowed && tools?.include !== undefined && !tools.include.includes(name)) include.push(name);
  const exclude = new Set(tools?.exclude ?? []);
  if (allowed) exclude.delete(name);
  else exclude.add(name);
  const next: { include?: string[]; exclude?: string[] } = {};
  if (include.length > 0) next.include = include;
  if (exclude.size > 0) next.exclude = [...exclude];
  return next.include === undefined && next.exclude === undefined ? undefined : next;
}

/**
 * The permission node an `Ask first` checkbox reflects: same owner,
 * `item.tool` exactly `toolName` (`'<server key>__<tool>'`) and
 * `action: 'ask'`.
 */
export function askFirstNode(
  graph: Graph,
  owner: string | null,
  toolName: string,
): NodeOfKind<'permission'> | undefined {
  return graph.nodes.find(
    (n): n is NodeOfKind<'permission'> =>
      n.kind === 'permission' &&
      n.owner === owner &&
      n.proposed !== 'remove' &&
      (n.data as PermissionNodeData).item.tool === toolName &&
      (n.data as PermissionNodeData).item.action === 'ask'
  );
}

/** Every permission rule's `item.id` — the `taken` set for `nextItemId('p', …)`. */
export function permissionIds(graph: Graph): string[] {
  return graph.nodes
    .filter((n) => n.kind === 'permission')
    .map((n) => (n.data as PermissionNodeData).item.id);
}
