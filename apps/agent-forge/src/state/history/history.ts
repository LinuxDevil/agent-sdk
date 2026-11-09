/**
 * The undo/redo stacks (C20): a `History` is two stacks of JSON-patch
 * entries over the document `{ spec, layout }` — never snapshots, so every
 * undo lands on a state that round-trips through `specToGraph`. Entries
 * coalesce (typing bursts, node drags) within `COALESCE_MS` when they share
 * a `coalesceKey`, and the past is capped at `HISTORY_LIMIT`.
 */
import type { AgentSpecV2 } from '../../graph/v2/specTypes';
import type { CanvasLayout } from '../../../shared/wireTypes';
import { applyPatch, diffJson, type PatchOp } from './jsonPatch';

/** The document undo/redo patches are computed over: the spec plus its canvas layout. */
export interface DocState {
  spec: AgentSpecV2;
  layout: CanvasLayout;
}

/** One undoable change: `forward` turns its `before` into `after`, `backward` the reverse. */
export interface HistoryEntry {
  forward: PatchOp[];
  backward: PatchOp[];
  /** Shown in the toolbar tooltip, e.g. 'Edit', 'Move', 'field:tool:http:name'. */
  label: string;
  /** `Date.now()` of the change (or the merge that last extended it). */
  at: number;
  /** Edits sharing a key within COALESCE_MS merge into one entry. */
  coalesceKey?: string;
}

export interface History {
  /** Undone-able entries, oldest first; the last is the next undo. */
  past: HistoryEntry[];
  /** Redo-able entries, oldest first; the last is the next redo. */
  future: HistoryEntry[];
}

/** Maximum kept undo steps; older entries are dropped. */
export const HISTORY_LIMIT = 100;
/** How long same-key edits keep merging into one entry (ms). */
export const COALESCE_MS = 600;

export function emptyHistory(): History {
  return { past: [], future: [] };
}

/**
 * The state the last entry started from: `before` is the state just before
 * the new change, i.e. the last entry's result — applying its `backward`
 * patch recovers the entry's own `before`. Returns undefined when `before`
 * is not that result (an unrecorded edit landed in between), which makes
 * merging unsafe.
 */
function entryStart(h: History, before: DocState): DocState | undefined {
  const last = h.past[h.past.length - 1];
  if (!last) return undefined;
  const start = applyPatch(before, last.backward);
  // Only merge when `before` really is the last entry's result — an
  // unrecorded change (history: false) would make the merged patches
  // describe a state the document was never in.
  return diffJson(applyPatch(start, last.forward), before).length === 0 ? start : undefined;
}

/**
 * Records the change `before → after`. No-op (same history returned) when
 * the diff is empty. Merges into the last entry when `coalesceKey` matches
 * it and `at - last.at <= COALESCE_MS`: the merged entry then spans
 * `entryStart → after` with patches only — never a snapshot. Any record
 * clears `future`.
 */
export function record(
  h: History,
  before: DocState,
  after: DocState,
  label: string,
  at: number,
  coalesceKey?: string
): History {
  const forward = diffJson(before, after);
  if (forward.length === 0) return h;
  const backward = diffJson(after, before);

  const last = h.past[h.past.length - 1];
  if (
    last !== undefined &&
    coalesceKey !== undefined &&
    last.coalesceKey === coalesceKey &&
    at - last.at <= COALESCE_MS
  ) {
    const start = entryStart(h, before);
    if (start !== undefined) {
      const merged: HistoryEntry = {
        forward: diffJson(start, after),
        backward: diffJson(after, start),
        label,
        at,
        coalesceKey,
      };
      const past = [...h.past.slice(0, -1), merged];
      return { past, future: [] };
    }
  }

  const entry: HistoryEntry = { forward, backward, label, at, coalesceKey };
  const past = [...h.past, entry];
  return { past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past, future: [] };
}

/**
 * Steps back one entry: applies its `backward` patch to `current` and moves
 * it to `future`. `current` should be the document state the entry ended
 * in; returns undefined when there is nothing to undo. Throws
 * 'Patch does not apply' when `current` drifted from the recorded state
 * (e.g. an unrecorded edit) — callers catch and treat it as a no-op.
 */
export function undo(h: History, current: DocState): { history: History; state: DocState } | undefined {
  const entry = h.past[h.past.length - 1];
  if (entry === undefined) return undefined;
  const state = applyPatch(current, entry.backward);
  return {
    history: { past: h.past.slice(0, -1), future: [...h.future, entry] },
    state,
  };
}

/** Steps forward one entry: applies its `forward` patch to `current`. */
export function redo(h: History, current: DocState): { history: History; state: DocState } | undefined {
  const entry = h.future[h.future.length - 1];
  if (entry === undefined) return undefined;
  const state = applyPatch(current, entry.forward);
  return {
    history: { past: [...h.past, entry], future: h.future.slice(0, -1) },
    state,
  };
}
