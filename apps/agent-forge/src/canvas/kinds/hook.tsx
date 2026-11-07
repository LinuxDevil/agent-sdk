/**
 * The `KindView` for `hook` nodes — every `spec.hooks` entry (`HookSpec`).
 * The card's title is the inline hook's name or the file's basename, its
 * chip the hook point ('before tool call', …) or `file`, and its rows an
 * `off` status while `inline.enabled === false`. `Fields` is the hook
 * Inspector (`hook/HookFields.tsx`); the palette offers a single "Hook"
 * entry under Safety that creates an inline `audit-log` hook with the next
 * free `h<n>` id.
 */
import { Webhook } from 'lucide-react';
import { allHookIds } from '../../graph/v2/kinds/hook';
import { nextItemId } from '../../graph/v2/nodeIds';
import type { InlineHookSpec } from '../../graph/v2/specTypes';
import type { NodeOfKind } from '../../graph/v2/types';
import { HOOK_TEMPLATES } from '../../hooks/hookTemplates';
import { HookFields } from './hook/HookFields';
import type { KindView, NodeRow, PaletteEntry } from './index';

/** The chip text per spec hook point. */
const POINT_CHIP: Record<InlineHookSpec['point'], string> = {
  preToolCall: 'before tool call',
  postToolCall: 'after tool call',
  preGenerate: 'before model call',
  postGenerate: 'after model call',
};

/** The last path segment of `file` ('hooks/loop-guard.ts' → 'loop-guard.ts'), extension kept. */
function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(slash + 1);
}

/** The card title: the inline `name`, or the file's basename for file hooks. */
function title(node: NodeOfKind<'hook'>): string {
  const { item } = node.data;
  if ('file' in item) return basename(item.file) || item.file;
  return item.inline.name;
}

/** The card rows: `off` while the inline hook is disabled, nothing otherwise. */
function rows(node: NodeOfKind<'hook'>): NodeRow[] {
  const { item } = node.data;
  return 'inline' in item && item.inline.enabled === false ? [{ k: 'status', v: 'off' }] : [];
}

/** The palette's default hook: the audit-log template at `postToolCall`. */
const AUDIT_LOG = HOOK_TEMPLATES.find((t) => t.id === 'audit-log');

const PALETTE: PaletteEntry[] = [
  {
    id: 'hook',
    group: 'Safety',
    label: 'Hook',
    description: 'Runs code before or after calls',
    kind: 'hook',
    create: (graph) => ({
      kind: 'hook',
      data: {
        item: {
          id: nextItemId('h', allHookIds(graph)),
          inline: {
            name: 'audit-log',
            point: 'postToolCall',
            code: AUDIT_LOG?.code ?? '',
          },
        },
      },
    }),
  },
];

/** The `hook` kind's card + Inspector, registered in `KIND_VIEWS` (canvas/kinds/index.ts). */
export const HOOK_VIEW: KindView<'hook'> = {
  label: 'Hook',
  tone: 'warning',
  Icon: Webhook,
  title,
  chip: (node) => ('file' in node.data.item ? 'file' : POINT_CHIP[node.data.item.inline.point]),
  rows,
  ports: { in: true, out: false },
  Fields: HookFields,
  palette: PALETTE,
};
