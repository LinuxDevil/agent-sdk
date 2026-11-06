/**
 * The `KindView` for `handoff` nodes — the `spec.handoffs` entries. The
 * card's title is the target, its chip the resolved transfer tool name,
 * and its rows the input filter and input schema. `Fields` is the handoff
 * Inspector (`handoff/HandoffFields.tsx`); the palette offers a single
 * Handoff entry under Agents. The `handsOff` edge to a sibling subagent is
 * derived (`deriveEdges`), so the card has an in port only — users never
 * draw the second edge.
 */
import { ArrowRightLeft } from 'lucide-react';
import type { NodeOfKind } from '../../graph/v2/types';
import { HandoffFields } from './handoff/HandoffFields';
import type { KindView, NodeRow, PaletteEntry } from './index';

/** The `filter` row text per `inputFilter` preset. */
const FILTER_TEXT: Record<string, string> = {
  removeToolCalls: 'remove tool calls',
  lastUserMessage: 'last user message',
};

/** The card rows, in the ticket's order; absent fields are skipped. */
function rows(node: NodeOfKind<'handoff'>): NodeRow[] {
  const { item } = node.data;
  const rows: NodeRow[] = [];
  if (item.inputFilter !== undefined) {
    rows.push({ k: 'filter', v: FILTER_TEXT[item.inputFilter] ?? item.inputFilter });
  }
  if (item.inputJsonSchema !== undefined) rows.push({ k: 'input', v: 'schema' });
  return rows;
}

const PALETTE: PaletteEntry[] = [
  {
    id: 'handoff',
    group: 'Agents',
    label: 'Handoff',
    description: 'Passes the conversation on',
    kind: 'handoff',
    create: () => ({ kind: 'handoff', data: { item: { agent: '' } } }),
  },
];

/** The `handoff` kind's card + Inspector, registered in `KIND_VIEWS` (canvas/kinds/index.ts). */
export const HANDOFF_VIEW: KindView<'handoff'> = {
  label: 'Handoff',
  tone: 'violet',
  Icon: ArrowRightLeft,
  title: (node) => node.data.item.agent || '(no target)',
  chip: (node) => {
    const { item } = node.data;
    return item.agent === '' ? undefined : (item.toolName ?? `transfer_to_${item.agent}`);
  },
  rows,
  ports: { in: true, out: false },
  Fields: HandoffFields,
  palette: PALETTE,
};
