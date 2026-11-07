import { describe, expect, it } from 'vitest';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';

import { render as mount } from '../../ui/__tests__/render';

import { NODE_TYPES, flowNodeType, type CanvasNodeData } from '../AgentNode';
import { NoteFields } from '../kinds/note/NoteFields';
import type { GraphNode, NoteNodeData } from '../../graph/v2/types';
import type { KindFieldsProps } from '../kinds';
import { act } from 'react';

function noteNode(text: string): GraphNode {
  return {
    id: 'note:n1',
    kind: 'note',
    owner: null,
    position: { x: 0, y: -160 },
    data: { text },
  };
}

function mountNote(text: string): HTMLDivElement {
  const node = noteNode(text);
  const Card = NODE_TYPES[flowNodeType('note')];
  const data: CanvasNodeData = { graphNode: node };
  const props = { id: node.id, type: flowNodeType('note'), data, selected: false } as unknown as NodeProps;
  return mount(
    <ReactFlowProvider>
      <Card {...props} />
    </ReactFlowProvider>,
  );
}

describe('NoteNode', () => {
  it('renders the note text in a .rf-note card', () => {
    const card = mountNote('Ask legal first');
    const el = card.querySelector('.rf-note')!;
    expect(el.textContent).toBe('Ask legal first');
    expect(el.getAttribute('data-node-kind')).toBe('note');
    expect(el.getAttribute('data-node-id')).toBe('note:n1');
  });

  it('shows the Empty note placeholder in the faint colour slot', () => {
    const card = mountNote('');
    const placeholder = card.querySelector('.rf-note-empty')!;
    expect(placeholder.textContent).toBe('Empty note');
  });

  it('draws no handles - a note takes no connections', () => {
    const card = mountNote('hi');
    expect(card.querySelectorAll('.react-flow__handle').length).toBe(0);
  });
});

describe('NoteFields', () => {
  it('writes data.text through patch', () => {
    const patches: Record<string, unknown>[] = [];
    const node = noteNode('old') as Extract<GraphNode, { kind: 'note' }>;
    const props: KindFieldsProps<'note'> = {
      node,
      graph: { version: 2, nodes: [node], emptySections: [], unplaced: [] },
      patch: (patch) => patches.push(patch),
      replace: () => {},
      problems: [],
    };
    const container = mount(<NoteFields {...props} />);
    const textarea = container.querySelector<HTMLTextAreaElement>('#node-note-text')!;
    expect(textarea.value).toBe('old');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'new text',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(patches).toStrictEqual([{ text: 'new text' }]);
    const data = (node.data as NoteNodeData).text;
    expect(data).toBe('old'); // patch is reported, not applied locally
  });
});
