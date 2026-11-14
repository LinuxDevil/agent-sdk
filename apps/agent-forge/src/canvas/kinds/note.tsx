/**
 * The `KindView` for `note` nodes — the free sticky notes of
 * `layout.notes`, canvas-only text that never enters the agent spec. The
 * canvas renders them through `NoteNode` (`agent-note`), so the view only
 * supplies the Inspector head (title 'Note'), the `NoteFields` body and
 * the palette's "Note" entry under Canvas, which creates an empty
 * ownerless note.
 */
import { StickyNote } from 'lucide-react';
import { NoteFields } from './note/NoteFields';
import type { KindView, PaletteEntry } from './index';

const PALETTE: PaletteEntry[] = [
  {
    id: 'note',
    group: 'Canvas',
    label: 'Note',
    description: 'A comment on the canvas',
    kind: 'note',
    create: () => ({ kind: 'note', data: { text: '' } }),
  },
];

/** The `note` kind's Inspector + palette entry, registered in `KIND_VIEWS` (canvas/kinds/index.ts). */
export const NOTE_VIEW: KindView<'note'> = {
  label: 'Note',
  tone: 'neutral',
  Icon: StickyNote,
  title: () => 'Note',
  rows: () => [],
  ports: { in: false, out: false },
  Fields: NoteFields,
  palette: PALETTE,
};
