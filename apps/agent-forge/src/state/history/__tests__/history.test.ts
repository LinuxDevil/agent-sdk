import { describe, expect, it } from 'vitest';
import type { AgentSpecV2 } from 'lousho';
import type { CanvasLayout } from '../../../../shared/wireTypes';
import {
  COALESCE_MS,
  HISTORY_LIMIT,
  emptyHistory,
  record,
  redo,
  undo,
  type DocState,
} from '../history';

function doc(name: string, x = 0): DocState {
  return {
    spec: { version: 2, name, model: 'mock/mock-1', instructions: 'hi' } as AgentSpecV2,
    layout: { schemaVersion: 1, nodes: { agent: { x, y: 0 } } } satisfies CanvasLayout,
  };
}

const renamed = (d: DocState, name: string): DocState => ({ ...d, spec: { ...d.spec, name } });
const moved = (d: DocState, x: number): DocState => ({
  ...d,
  layout: { ...d.layout, nodes: { agent: { x, y: 0 } } },
});

describe('record/undo/redo', () => {
  it('undoes and redoes a recorded change', () => {
    const d1 = doc('a');
    const d2 = renamed(d1, 'b');
    const h1 = record(emptyHistory(), d1, d2, 'Edit', 1000);
    expect(h1.past).toHaveLength(1);
    expect(h1.future).toHaveLength(0);

    const back = undo(h1, d2);
    expect(back?.state).toEqual(d1);
    expect(back?.history.past).toHaveLength(0);
    expect(back?.history.future).toHaveLength(1);

    const forward = redo(back!.history, back!.state);
    expect(forward?.state).toEqual(d2);
    expect(forward?.history.past).toHaveLength(1);
    expect(forward?.history.future).toHaveLength(0);
  });

  it('returns undefined on empty stacks', () => {
    const h = emptyHistory();
    expect(undo(h, doc('a'))).toBeUndefined();
    expect(redo(h, doc('a'))).toBeUndefined();
  });

  it('does not record a no-op diff', () => {
    const h = emptyHistory();
    const d = doc('a');
    expect(record(h, d, { ...d }, 'Edit', 1000)).toBe(h);
  });

  it('clears future on a new record', () => {
    const d1 = doc('a');
    const d2 = renamed(d1, 'b');
    const d3 = renamed(d2, 'c');
    let h = record(emptyHistory(), d1, d2, 'Edit', 1000);
    h = undo(h, d2)!.history;
    h = record(h, d1, d3, 'Edit', 2000);
    expect(h.future).toHaveLength(0);
    expect(h.past).toHaveLength(1);
  });

  it('caps the past at HISTORY_LIMIT, dropping the oldest', () => {
    let h = emptyHistory();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      h = record(h, doc(`a${i}`), doc(`b${i}`), 'Edit', i);
    }
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    // The oldest kept entry is the 6th recorded change ('a5' -> 'b5').
    expect(h.past[0].forward.length).toBeGreaterThan(0);
    let state = doc('b104');
    // Undoing the whole kept window lands on the state after entry 5's "before",
    // i.e. doc('a5') — entries 0-4 were dropped.
    let cur = h;
    while (cur.past.length > 0) {
      const step = undo(cur, state)!;
      state = step.state;
      cur = step.history;
    }
    expect(state).toEqual(doc('a5'));
  });
});

describe('coalescing', () => {
  it('merges same-key edits inside COALESCE_MS into one entry', () => {
    const d0 = doc('a');
    const d1 = renamed(d0, 'b');
    const d2 = renamed(d1, 'c');
    let h = record(emptyHistory(), d0, d1, 'Edit', 1000, 'field:x:name');
    h = record(h, d1, d2, 'Edit', 1000 + COALESCE_MS, 'field:x:name');
    expect(h.past).toHaveLength(1);
    const back = undo(h, d2);
    expect(back?.state).toEqual(d0);
  });

  it('starts a new entry after the coalescing window', () => {
    const d0 = doc('a');
    const d1 = renamed(d0, 'b');
    const d2 = renamed(d1, 'c');
    let h = record(emptyHistory(), d0, d1, 'Edit', 1000, 'field:x:name');
    h = record(h, d1, d2, 'Edit', 1000 + COALESCE_MS + 1, 'field:x:name');
    expect(h.past).toHaveLength(2);
  });

  it('does not merge different coalesce keys', () => {
    const d0 = doc('a');
    const d1 = renamed(d0, 'b');
    const d2 = moved(d1, 5);
    let h = record(emptyHistory(), d0, d1, 'Edit', 1000, 'field:x:name');
    h = record(h, d1, d2, 'Move', 1100, 'move:agent');
    expect(h.past).toHaveLength(2);
  });

  it('does not merge when an unrecorded edit landed in between', () => {
    const d0 = doc('a');
    const d1 = renamed(d0, 'b');
    const drifted = moved(d1, 9); // a history:false change: never recorded
    const d2 = renamed(drifted, 'c');
    let h = record(emptyHistory(), d0, d1, 'Edit', 1000, 'k');
    // `before` for the second record is `drifted`, not d1 — merging would
    // produce patches describing a state the document was never in.
    h = record(h, drifted, d2, 'Edit', 1100, 'k');
    expect(h.past).toHaveLength(2);
    // The second entry still undoes correctly to `drifted`.
    expect(undo(h, d2)?.state).toEqual(drifted);
  });
});
