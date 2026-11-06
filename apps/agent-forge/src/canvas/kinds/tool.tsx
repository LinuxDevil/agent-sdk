/**
 * The `KindView` for `tool` nodes — every `spec.tools` entry (`ToolRef`).
 * The card's title is the `toolNodeName`, its chip the ref's form, and its
 * rows the approval mode, on-demand loading, a registry version or an
 * OpenAPI host. `Fields` is the tool Inspector (`tool/ToolFields.tsx`);
 * the palette offers the built-in, OpenAPI and integration entries under
 * Capabilities.
 */
import { Wrench } from 'lucide-react';
import { toolNodeName } from '../../graph/v2/nodeIds';
import type { NodeOfKind } from '../../graph/v2/types';
import { ToolFields } from './tool/ToolFields';
import { TOOL_FORM_CHIP, toolFormOf } from './tool/toolForm';
import { urlHost } from './urlHost';
import type { KindView, NodeRow, PaletteEntry } from './index';

/** The `approval` row text per mode. */
const APPROVAL_TEXT: Record<string, string> = {
  always: 'always ask',
  never: 'never ask',
  auto: 'model decides',
};

/** The card rows, in the ticket's order; absent fields are skipped. */
function rows(node: NodeOfKind<'tool'>): NodeRow[] {
  const { item } = node.data;
  const rows: NodeRow[] = [];
  if ('approval' in item && item.approval !== undefined) {
    rows.push({ k: 'approval', v: APPROVAL_TEXT[item.approval] ?? item.approval });
  }
  if ('deferLoading' in item && item.deferLoading === true) {
    rows.push({ k: 'loading', v: 'on demand' });
  }
  if ('registry' in item && item.version !== undefined && item.version !== '') {
    rows.push({ k: 'version', v: item.version });
  }
  if ('openapi' in item && item.openapi.url !== '') {
    rows.push({ k: 'host', v: urlHost(item.openapi.url) });
  }
  return rows;
}

const PALETTE: PaletteEntry[] = [
  {
    id: 'tool',
    group: 'Capabilities',
    label: 'Tool',
    description: 'Runs a built-in tool',
    kind: 'tool',
    create: () => ({ kind: 'tool', data: { item: { builtin: '' } } }),
  },
  {
    id: 'tool-openapi',
    group: 'Capabilities',
    label: 'OpenAPI tools',
    description: 'One tool per API operation',
    kind: 'tool',
    create: () => ({ kind: 'tool', data: { item: { openapi: { url: '' } } } }),
  },
  {
    id: 'tool-integration',
    group: 'Capabilities',
    label: 'Integration',
    description: 'GitHub, Jira, Slack or email',
    kind: 'tool',
    create: () => ({ kind: 'tool', data: { item: { integration: 'github', credentials: {} } } }),
  },
];

/** The `tool` kind's card + Inspector, registered in `KIND_VIEWS` (canvas/kinds/index.ts). */
export const TOOL_VIEW: KindView<'tool'> = {
  label: 'Tool',
  tone: 'info',
  Icon: Wrench,
  title: (node) => toolNodeName(node.data.item),
  chip: (node) => TOOL_FORM_CHIP[toolFormOf(node.data.item)],
  rows,
  ports: { in: true, out: true },
  Fields: ToolFields,
  palette: PALETTE,
};
