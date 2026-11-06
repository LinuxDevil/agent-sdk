/**
 * The `KindView` for `skill` nodes — every `spec.skills` entry (`SkillRef`).
 * The card's title is the `skillNodeName`, its chip the source (`folder` /
 * `registry` / `inline`), and its rows the folder path or the inline
 * description. `Fields` is the skill Inspector (`skill/SkillFields.tsx`);
 * the palette offers a single "Skill" entry under Capabilities that
 * creates an inline skill with a fresh `skill`, `skill-2`, … name.
 */
import { BookOpen } from 'lucide-react';
import { skillNodeName, uniqueName } from '../../graph/v2/nodeIds';
import { skillSiblingNames } from '../../graph/v2/kinds/skill';
import type { NodeOfKind } from '../../graph/v2/types';
import { SkillFields } from './skill/SkillFields';
import type { KindView, NodeRow, PaletteEntry } from './index';

/** `text` cut to ≤ 40 chars (a trailing '…' marks the cut), like the agent card's instructions row. */
function clip(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** The chip text per `SkillRef` form. */
function chip(item: NodeOfKind<'skill'>['data']['item']): string {
  if ('dir' in item) return 'folder';
  return 'registry' in item ? 'registry' : 'inline';
}

/** The card rows: the folder's path for `dir`, the clipped description for `inline`, none for `registry`. */
function rows(node: NodeOfKind<'skill'>): NodeRow[] {
  const { item } = node.data;
  if ('dir' in item) return item.dir === '' ? [] : [{ k: 'path', v: item.dir }];
  if ('inline' in item) {
    return item.inline.description === '' ? [] : [{ k: 'about', v: clip(item.inline.description) }];
  }
  return [];
}

const PALETTE: PaletteEntry[] = [
  {
    id: 'skill',
    group: 'Capabilities',
    label: 'Skill',
    description: 'Instructions loaded on demand',
    kind: 'skill',
    create: (graph, owner) => ({
      kind: 'skill',
      data: {
        item: {
          inline: {
            name: uniqueName('skill', skillSiblingNames(graph, owner)),
            description: '',
            content: '',
          },
        },
      },
    }),
  },
];

/** The `skill` kind's card + Inspector, registered in `KIND_VIEWS` (canvas/kinds/index.ts). */
export const SKILL_VIEW: KindView<'skill'> = {
  label: 'Skill',
  tone: 'info',
  Icon: BookOpen,
  title: (node) => skillNodeName(node.data.item),
  chip: (node) => chip(node.data.item),
  rows,
  ports: { in: true, out: false },
  Fields: SkillFields,
  palette: PALETTE,
};
