/**
 * The `KindView` for `mcp` nodes — every `spec.mcpServers` entry. The
 * card's title is the record key, its chip the transport (`stdio` /
 * `http`), and its rows the command line or URL host, the tools filter
 * and the approval mode. `Fields` is the MCP Inspector
 * (`mcp/McpFields.tsx`); the palette offers a single "MCP server" entry
 * under Capabilities.
 */
import { Plug } from 'lucide-react';
import { uniqueName } from '../../graph/v2/nodeIds';
import { mcpSiblingKeys } from '../../graph/v2/order';
import type { NodeOfKind } from '../../graph/v2/types';
import { McpFields } from './mcp/McpFields';
import { transportOf } from './mcp/mcpItem';
import { urlHost } from './urlHost';
import type { KindView, NodeRow, PaletteEntry } from './index';

/** `text` cut to ≤ 40 chars (a trailing '…' marks the cut), like the agent card's instructions row. */
function clip(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** The `approval` row text per mode; `always` (the default) shows nothing. */
const APPROVAL_TEXT: Record<string, string> = {
  annotations: 'hints',
  never: 'never ask',
};

/** The card rows, in the ticket's order; absent fields are skipped. */
function rows(node: NodeOfKind<'mcp'>): NodeRow[] {
  const { item } = node.data;
  const rows: NodeRow[] = [];
  if ('command' in item) {
    rows.push({ k: 'command', v: clip([item.command, ...(item.args ?? [])].join(' ')) });
  } else {
    rows.push({ k: 'host', v: urlHost(item.url) });
  }
  const tools = item.tools;
  if (tools?.include !== undefined && tools.include.length > 0) {
    rows.push({ k: 'tools', v: `only ${tools.include.length}` });
  } else if (tools?.exclude !== undefined && tools.exclude.length > 0) {
    rows.push({ k: 'tools', v: `${tools.exclude.length} off` });
  }
  const approval = typeof item.approval === 'string' ? APPROVAL_TEXT[item.approval] : undefined;
  if (approval !== undefined) rows.push({ k: 'approval', v: approval });
  return rows;
}

const PALETTE: PaletteEntry[] = [
  {
    id: 'mcp',
    group: 'Capabilities',
    label: 'MCP server',
    description: 'Tools from an MCP server',
    keywords: ['server', 'plugin'],
    kind: 'mcp',
    create: (graph, owner) => ({
      kind: 'mcp',
      data: { key: uniqueName('server', mcpSiblingKeys(graph, owner)), item: { command: '' } },
    }),
  },
];

/** The `mcp` kind's card + Inspector, registered in `KIND_VIEWS` (canvas/kinds/index.ts). */
export const MCP_VIEW: KindView<'mcp'> = {
  label: 'MCP server',
  tone: 'info',
  Icon: Plug,
  title: (node) => node.data.key,
  chip: (node) => transportOf(node.data.item),
  rows,
  ports: { in: true, out: true },
  Fields: McpFields,
  palette: PALETTE,
};
