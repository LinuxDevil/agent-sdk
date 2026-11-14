import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';
import { useAgentDocument } from '../useAgentDocument';
import type { AgentStore } from '../../persistence/AgentStore';

/**
 * `useAgentDocument`'s `setGraph` dirty flag: the elkjs unplaced-node
 * layout (C17) writes positions with `{ dirty: false }` so recomputed
 * positions never mark the agent dirty on their own.
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

function store(): AgentStore {
  return {
    list: vi.fn(async () => []),
    load: vi.fn(async () => undefined),
    save: vi.fn(async () => {}),
    saveLayout: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

describe('useAgentDocument setGraph dirty flag', () => {
  it('setGraph marks the document dirty by default', async () => {
    render(<Probe store={store()} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(doc?.dirty).toBe(false);
    act(() => doc?.setGraph((g) => g));
    expect(doc?.dirty).toBe(true);
  });

  it('setGraph(updater, { dirty: false }) applies the graph without dirtying', async () => {
    render(<Probe store={store()} />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => doc?.setGraph((g) => ({ ...g, unplaced: [] }), { dirty: false }));
    expect(doc?.dirty).toBe(false);
    expect(doc?.graph.unplaced).toEqual([]);
    // A later plain edit still dirties as usual.
    act(() => doc?.setGraph((g) => g));
    expect(doc?.dirty).toBe(true);
  });
});
