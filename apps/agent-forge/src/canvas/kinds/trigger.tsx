/**
 * The `KindView` for `trigger` nodes — every `spec.triggers` entry
 * (`TriggerSpec`). The card's title names what starts a run (`Schedule`,
 * `Webhook`, the channel label or `After <agent>`), its chip the cron
 * expression, path, channel or run status, and its rows the prompt,
 * template, time zone and filter. `Fields` is the trigger Inspector
 * (`trigger/TriggerFields.tsx`); the palette offers one Start entry per
 * trigger type.
 */
import { Zap } from 'lucide-react';
import { nextItemId } from '../../graph/v2/nodeIds';
import { triggerSiblingIds } from '../../graph/v2/kinds/trigger';
import type { TriggerSpec } from '../../graph/v2/specTypes';
import type { NodeOfKind } from '../../graph/v2/types';
import { TriggerFields } from './trigger/TriggerFields';
import { emptyTriggerItem, triggerTitle } from './trigger/triggerItem';
import type { KindView, NodeRow, PaletteEntry } from './index';

/** The chip text per trigger type; chat and catalog-extra types carry none. */
function chip(item: TriggerSpec): string | undefined {
  switch (item.type) {
    case 'cron':
      return item.cron;
    case 'webhook':
      return item.path;
    case 'channel':
      return item.channel;
    case 'agent':
      return `on ${item.on}`;
    default:
      return undefined;
  }
}

/** The first line of `text`, clipped to 40 characters — the card's `prompt`/`template` row value. */
function clip(text: string): string {
  const line = text.split('\n', 1)[0];
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

/** The card rows: the prompt/template text when set, the cron time zone and the optional filter. */
function rows(node: NodeOfKind<'trigger'>): NodeRow[] {
  const { item } = node.data;
  const result: NodeRow[] = [];
  if (item.type === 'cron') {
    if (item.prompt !== '') result.push({ k: 'prompt', v: clip(item.prompt) });
    if (item.timezone !== undefined && item.timezone !== '') {
      result.push({ k: 'zone', v: item.timezone });
    }
  }
  if ((item.type === 'webhook' || item.type === 'agent') && item.promptTemplate !== '') {
    result.push({ k: 'template', v: clip(item.promptTemplate) });
  }
  if ((item.type === 'webhook' || item.type === 'channel') && item.filter !== undefined && item.filter !== '') {
    result.push({ k: 'filter', v: item.filter });
  }
  return result;
}

/** One Start-group palette entry: `create` gives the type's empty value a fresh `t<n>` id. */
function paletteEntry(id: string, label: string, description: string, type: string, keywords?: string[]): PaletteEntry {
  return {
    id,
    group: 'Start',
    label,
    description,
    keywords,
    kind: 'trigger',
    create: (graph) => ({
      kind: 'trigger',
      data: { item: emptyTriggerItem(type, nextItemId('t', triggerSiblingIds(graph))) },
    }),
  };
}

const PALETTE: PaletteEntry[] = [
  paletteEntry('trigger-chat', 'Chat', 'Starts on a message', 'chat'),
  paletteEntry('trigger-cron', 'Schedule', 'Starts on a cron schedule', 'cron', ['schedule', 'timer']),
  paletteEntry('trigger-webhook', 'Webhook', 'Starts on an HTTP call', 'webhook'),
  paletteEntry('trigger-channel', 'Channel', 'Slack, Telegram, GitHub and more', 'channel'),
  paletteEntry('trigger-agent', 'After another agent', 'Chains agents', 'agent'),
];

/** The `trigger` kind's card + Inspector, registered in `KIND_VIEWS` (canvas/kinds/index.ts). */
export const TRIGGER_VIEW: KindView<'trigger'> = {
  label: 'Trigger',
  tone: 'accent',
  Icon: Zap,
  title: (node) => triggerTitle(node.data.item),
  chip: (node) => chip(node.data.item),
  rows,
  ports: { in: false, out: true },
  Fields: TriggerFields,
  palette: PALETTE,
};
