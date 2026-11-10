import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';
import { useAgentDocument } from '../useAgentDocument';
import type { AgentStore } from '../../persistence/AgentStore';
import { addNode, moveNode, patchNode } from '../../graph/v2/mutations';
import { ROOT_AGENT_ID } from '../../graph/v2/types';
import type { AgentSpecV2 } from '../../graph/v2/specTypes';
import type { AgentRecord } from '../../../shared/wireTypes';

/**
 * `useAgentDocument`'s undo/redo wiring (C20): the ticket's three-step
 * scenario — add a node, move it, edit a field — through `setGraph` with
 * the real `graphToSpec`/`specToGraph` conversions; three undos restore
 * the original spec and layout exactly, three redos reapply them. Plus
 * field coalescing, selection keeping and history reset on agent switch.
 */

vi.mock('../../runtime/runtimeClient', () => ({
  runtimeClient: {
    subscribeEvents: () => () => {},
  },
}));

let doc: ReturnType<typeof useAgentDocument> | undefined;

function Probe({ store }: { store: AgentStore }) {
  doc = useAgentDocument(store);
  return null;
}

const OTHER_SPEC: AgentSpecV2 = {
  version: 2,
  name: 'other',
  model: 'mock/mock-1',
  instructions: 'Other agent.',
};

function store(): AgentStore {
  return {
    list: vi.fn(async () => []),
    load: vi.fn(async (id: string) =>
      id === 'other'
        ? ({
            spec: OTHER_SPEC,
            layout: { schemaVersion: 1, nodes: {}, notes: [] },
          } as unknown as AgentRecord)
        : undefined
    ),
    save: vi.fn(async () => {}),
    saveLayout: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

async function mount(st: AgentStore) {
  render(<Probe store={st} />);
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useAgentDocument undo/redo', () => {
  it('undoes and redoes add/move/edit, restoring spec and layout exactly', async () => {
    await mount(store());
    const startSpec = doc!.spec;
    const startLayout = doc!.layout;

    let nodeId = '';
    act(() => {
      doc!.setGraph(
        (g) => {
          const added = addNode(
            g,
            { kind: 'tool', data: { item: { builtin: 'web_fetch' } } },
            { x: 120, y: 80 },
            ROOT_AGENT_ID
          );
          nodeId = added.nodeId;
          return added.graph;
        },
        { history: { label: 'Add' } }
      );
    });
    act(() => doc!.setSelectedNodeId(nodeId));
    act(() =>
      doc!.setGraph((g) => moveNode(g, nodeId, { x: 340, y: 200 }), {
        history: { label: 'Move', coalesceKey: `move:${nodeId}` },
      })
    );
    act(() =>
      doc!.setGraph((g) => patchNode(g, nodeId, { deferLoading: true }), {
        history: { label: 'Edit', coalesceKey: `field:${nodeId}:deferLoading` },
      })
    );

    const endSpec = doc!.spec;
    const endLayout = doc!.layout;
    expect(endSpec).not.toEqual(startSpec);
    expect(doc!.canUndo).toBe(true);
    expect(doc!.canRedo).toBe(false);
    expect(doc!.undoLabel).toBe('Edit');

    // Undo the field edit: the node survives, so the selection is kept.
    act(() => doc!.undo());
    expect(doc!.selectedNodeId).toBe(nodeId);
    expect(doc!.dirty).toBe(true);
    const tool = doc!.spec.tools?.find((t) => 'builtin' in t && t.builtin === 'web_fetch');
    expect(tool).toEqual({ builtin: 'web_fetch' });
    expect(doc!.layout.nodes[nodeId]).toEqual({ x: 340, y: 200 });

    // Undo the move: position restored, node (and selection) still there.
    act(() => doc!.undo());
    expect(doc!.selectedNodeId).toBe(nodeId);
    expect(doc!.layout.nodes[nodeId]).toEqual({ x: 120, y: 80 });

    // Undo the add: back to the original spec and layout exactly; the
    // selected node is gone, so the selection clears.
    act(() => doc!.undo());
    expect(doc!.spec).toEqual(startSpec);
    expect(doc!.layout).toEqual(startLayout);
    expect(doc!.selectedNodeId).toBeUndefined();
    expect(doc!.canUndo).toBe(false);
    expect(doc!.redoLabel).toBe('Add');

    // Three redos reapply everything.
    act(() => doc!.redo());
    act(() => doc!.redo());
    act(() => doc!.redo());
    expect(doc!.spec).toEqual(endSpec);
    expect(doc!.layout).toEqual(endLayout);
    expect(doc!.canRedo).toBe(false);
  });

  it('coalesces same-field edits into one undo step', async () => {
    await mount(store());
    const startSpec = doc!.spec;
    const key = `field:${ROOT_AGENT_ID}:instructions`;
    act(() =>
      doc!.setGraph((g) => patchNode(g, ROOT_AGENT_ID, { instructions: 'First' }), {
        history: { label: 'Edit', coalesceKey: key },
      })
    );
    act(() =>
      doc!.setGraph((g) => patchNode(g, ROOT_AGENT_ID, { instructions: 'First draft' }), {
        history: { label: 'Edit', coalesceKey: key },
      })
    );
    act(() =>
      doc!.setGraph((g) => patchNode(g, ROOT_AGENT_ID, { instructions: 'First draft done' }), {
        history: { label: 'Edit', coalesceKey: key },
      })
    );
    expect(doc!.undoLabel).toBe('Edit');
    // One undo undoes the whole typing burst.
    act(() => doc!.undo());
    expect(doc!.spec).toEqual(startSpec);
    expect(doc!.canUndo).toBe(false);
  });

  it('clears the history when switching agents', async () => {
    await mount(store());
    act(() =>
      doc!.setGraph((g) => moveNode(g, ROOT_AGENT_ID, { x: 5, y: 5 }), {
        history: { label: 'Move' },
      })
    );
    expect(doc!.canUndo).toBe(true);
    await act(async () => {
      await doc!.switchAgent('other');
    });
    expect(doc!.agentId).toBe('other');
    expect(doc!.canUndo).toBe(false);
    expect(doc!.canRedo).toBe(false);
  });
});
