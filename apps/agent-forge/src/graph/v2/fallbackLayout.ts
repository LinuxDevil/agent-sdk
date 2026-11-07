/**
 * Deterministic fallback placement for nodes with no `layout.json` entry:
 * triggers on the left, the agent next, its capabilities in two columns,
 * subagents/handoffs on the right, flows below and notes above. elkjs (C17)
 * does the real layout; this grid only guarantees a stable position so a
 * node never appears at (0, 0).
 */
import type { GraphPosition, NodeKind } from './types';

/** px between grid columns (the v1 fallback used the same 256). */
const COLUMN_WIDTH = 256;
/** px between stacked nodes of one column. */
const ROW_HEIGHT = 120;
/** First y of the flow column, below the capability rows. */
const FLOW_TOP = 480;
/** y of the note column, above the canvas top. */
const NOTE_TOP = -160;
/** In-group layout: narrower cards laid out from the group's content origin. */
const GROUP_X0 = 24;
const GROUP_COLUMN_WIDTH = 224;
const GROUP_Y0 = 48;
const GROUP_ROW_HEIGHT = 104;

/**
 * Fallback column per kind. `agent` is the root agent only — an inline
 * subagent is counted as `subagent` (callers pass the effective kind).
 */
const COLUMN: Record<NodeKind, number> = {
  trigger: 0,
  abort: 0,
  note: 0,
  agent: 1,
  flow: 1,
  tool: 2,
  mcp: 2,
  skill: 2,
  memory: 2,
  guardrail: 3,
  permission: 3,
  hook: 3,
  output: 3,
  subagent: 4,
  handoff: 4,
};

/** The fallback column a kind stacks in — the counter key `indexInColumn` counts. */
export function fallbackColumn(kind: NodeKind): number {
  return COLUMN[kind];
}

/**
 * Deterministic position for a node with no layout entry. `indexInColumn`
 * counts nodes already placed in that column for the same owner; `inGroup`
 * switches to the compact in-group grid used inside a subagent group.
 */
export function fallbackPosition(kind: NodeKind, indexInColumn: number, inGroup: boolean): GraphPosition {
  const column = COLUMN[kind];
  if (inGroup) {
    return {
      x: GROUP_X0 + GROUP_COLUMN_WIDTH * Math.max(0, column - 2),
      y: GROUP_Y0 + GROUP_ROW_HEIGHT * indexInColumn,
    };
  }
  if (kind === 'flow') return { x: COLUMN_WIDTH, y: FLOW_TOP + indexInColumn * ROW_HEIGHT };
  if (kind === 'note') return { x: 0, y: NOTE_TOP };
  return { x: column * COLUMN_WIDTH, y: indexInColumn * ROW_HEIGHT };
}
