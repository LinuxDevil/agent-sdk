/**
 * The `KindView` for `abort` nodes — every `spec.abortListeners` entry
 * (`AbortListenerSpec`): a rule that cancels a trigger's queued or running
 * runs when an event matches. The card's title is `Cancel on ` plus the
 * watched trigger's C12 title (`(no trigger)` while `triggerId` is empty
 * or names a removed trigger), its chip the scope (`queued`, `running`,
 * `queued + running`), and its rows the clipped `when`/`match`
 * expressions. `Fields` is the abort Inspector
 * (`abort/AbortFields.tsx`); the palette offers one Start entry that is
 * unavailable until a webhook or channel trigger exists. The card draws
 * with a dashed border (`.rf-node[data-node-kind="abort"]` in agents.css),
 * matching Wakeel's dashed abort node.
 */
import { OctagonX } from 'lucide-react';
import {
  abortTriggerNodes,
  abortUnavailableReason,
  allAbortIds,
  triggerItemById,
} from '../../graph/v2/kinds/abort';
import { nextItemId } from '../../graph/v2/nodeIds';
import type { Graph, NodeOfKind } from '../../graph/v2/types';
import { AbortFields } from './abort/AbortFields';
import { clipFirstLine } from './clipFirstLine';
import { triggerTitle } from './trigger/triggerItem';
import type { KindView, NodeRow, PaletteEntry } from './index';

/** The card title: `Cancel on ` plus the watched trigger's title, or `(no trigger)`. */
function title(node: NodeOfKind<'abort'>, graph?: Graph): string {
  const trigger = graph === undefined ? undefined : triggerItemById(graph, node.data.item.triggerId);
  return `Cancel on ${trigger === undefined ? '(no trigger)' : triggerTitle(trigger)}`;
}

/** The chip text per `scope`. */
const SCOPE_CHIP: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  both: 'queued + running',
};

/** The card rows: the `when` and `match` expressions while they are set. */
function rows(node: NodeOfKind<'abort'>): NodeRow[] {
  const { when, match } = node.data.item;
  const result: NodeRow[] = [];
  if (when !== '') result.push({ k: 'when', v: clipFirstLine(when) });
  if (match !== '') result.push({ k: 'match', v: clipFirstLine(match) });
  return result;
}

const PALETTE: PaletteEntry[] = [
  {
    id: 'abort',
    group: 'Start',
    label: 'Abort listener',
    description: 'Cancels runs on an event',
    kind: 'abort',
    create: (graph) => {
      const first = abortTriggerNodes(graph)[0];
      return {
        kind: 'abort',
        data: {
          item: {
            id: nextItemId('a', allAbortIds(graph)),
            triggerId: first === undefined ? '' : first.data.item.id,
            when: '',
            match: '',
            scope: 'both',
          },
        },
      };
    },
    unavailable: (graph) => abortUnavailableReason(graph),
  },
];

/** The `abort` kind's card + Inspector, registered in `KIND_VIEWS` (canvas/kinds/index.ts). */
export const ABORT_VIEW: KindView<'abort'> = {
  label: 'Abort listener',
  tone: 'warning',
  Icon: OctagonX,
  title,
  chip: (node) => SCOPE_CHIP[node.data.item.scope] ?? node.data.item.scope,
  rows,
  ports: { in: true, out: false },
  Fields: AbortFields,
  palette: PALETTE,
};
