/**
 * The `KindView` for `guardrail` nodes — every `spec.guardrails` entry
 * (`GuardrailSpec`). The card's title is the built-in's name ('(pick one)'
 * while unset), its chip the sides it checks ('input', 'output' or 'both' —
 * a spec that also checks `tools` shows the sides joined), and its rows the
 * trip behaviour and the 'parallel' mode. `Fields` is the guardrail
 * Inspector (`guardrail/GuardrailFields.tsx`); the palette offers a single
 * "Guardrail" entry under Safety that creates a max-length check on both
 * sides with the next free `g<n>` id.
 */
import { ShieldCheck } from 'lucide-react';
import { allGuardrailIds } from '../../graph/v2/kinds/guardrail';
import { nextItemId } from '../../graph/v2/nodeIds';
import { guardrailSidesOf } from '../../graph/v2/specTypes';
import type { NodeOfKind } from '../../graph/v2/types';
import { GuardrailFields } from './guardrail/GuardrailFields';
import type { KindView, NodeRow, PaletteEntry } from './index';

/**
 * The chip text: 'both' for the input+output default, else the sides joined
 * ('input', 'output', 'tools', 'input + tools', …).
 */
function chip(node: NodeOfKind<'guardrail'>): string {
  const sides = guardrailSidesOf(node.data.item);
  if (!sides.includes('tools') && sides.includes('input') && sides.includes('output')) return 'both';
  return sides.join(' + ');
}

/** The card rows: the trip behaviour and the parallel mode, each only when set. */
function rows(node: NodeOfKind<'guardrail'>): NodeRow[] {
  const { item } = node.data;
  const result: NodeRow[] = [];
  if (item.onTripped !== undefined) result.push({ k: 'on trip', v: item.onTripped });
  if (item.runInParallel === true) result.push({ k: 'mode', v: 'parallel' });
  return result;
}

const PALETTE: PaletteEntry[] = [
  {
    id: 'guardrail',
    group: 'Safety',
    label: 'Guardrail',
    description: 'Checks input or output',
    kind: 'guardrail',
    create: (graph) => ({
      kind: 'guardrail',
      data: {
        item: {
          id: nextItemId('g', allGuardrailIds(graph)),
          name: 'max-length',
          on: ['input', 'output'],
        },
      },
    }),
  },
];

/** The `guardrail` kind's card + Inspector, registered in `KIND_VIEWS` (canvas/kinds/index.ts). */
export const GUARDRAIL_VIEW: KindView<'guardrail'> = {
  label: 'Guardrail',
  tone: 'warning',
  Icon: ShieldCheck,
  title: (node) => node.data.item.name || '(pick one)',
  chip,
  rows,
  ports: { in: true, out: false },
  Fields: GuardrailFields,
  palette: PALETTE,
};
