/**
 * The `KindView` for `permission` nodes — every `spec.permissions` entry
 * (`PermissionRuleSpec`). The card's title is the rule's tool list, its
 * chip the action (`allow` / `deny` / `ask` / `model decides`), and its
 * rows the condition count, the reason and the approval TTL. `Fields` is
 * the permission Inspector (`permission/PermissionFields.tsx`); the
 * palette offers a single "Permission rule" entry under Safety that
 * creates an `ask` rule over `*` with the next free `p<n>` id.
 */
import { KeyRound } from 'lucide-react';
import { allPermissionIds } from '../../graph/v2/kinds/permission';
import { nextItemId } from '../../graph/v2/nodeIds';
import type { PermissionRuleSpec } from '../../graph/v2/specTypes';
import type { NodeOfKind } from '../../graph/v2/types';
import { PermissionFields } from './permission/PermissionFields';
import type { KindView, NodeRow, PaletteEntry } from './index';

/** `text` cut to ≤ 40 chars (a trailing '…' marks the cut), like the mcp card's command row. */
function clip(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** The chip text per action. */
const ACTION_CHIP: Record<PermissionRuleSpec['action'], string> = {
  allow: 'allow',
  deny: 'deny',
  ask: 'ask',
  auto: 'model decides',
};

/** The card rows: the condition count, the reason and the approval TTL, each only when set. */
function rows(node: NodeOfKind<'permission'>): NodeRow[] {
  const { item } = node.data;
  const result: NodeRow[] = [];
  const conditions = item.when === undefined ? 0 : Object.keys(item.when).length;
  if (conditions > 0) {
    result.push({ k: 'when', v: conditions === 1 ? '1 condition' : `${conditions} conditions` });
  }
  if (item.reason !== undefined) result.push({ k: 'reason', v: item.reason });
  if (item.ttlMs !== undefined) result.push({ k: 'remember', v: `${item.ttlMs / 1000} s` });
  return result;
}

const PALETTE: PaletteEntry[] = [
  {
    id: 'permission',
    group: 'Safety',
    label: 'Permission rule',
    description: 'Allows, denies or asks per tool',
    keywords: ['approval', 'allow', 'deny'],
    kind: 'permission',
    create: (graph) => ({
      kind: 'permission',
      data: {
        item: {
          id: nextItemId('p', allPermissionIds(graph)),
          tool: '*',
          action: 'ask',
        },
      },
    }),
  },
];

/** The `permission` kind's card + Inspector, registered in `KIND_VIEWS` (canvas/kinds/index.ts). */
export const PERMISSION_VIEW: KindView<'permission'> = {
  label: 'Permission rule',
  tone: 'warning',
  Icon: KeyRound,
  title: (node) => clip([node.data.item.tool].flat().join(', ')) || '(no tools)',
  chip: (node) => ACTION_CHIP[node.data.item.action],
  rows,
  ports: { in: true, out: false },
  Fields: PermissionFields,
  palette: PALETTE,
};
