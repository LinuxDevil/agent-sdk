import { describe, it, expect } from 'vitest';
import { flattenObservationTree, nestObservations, traceBounds } from '../tree';
import type { ObserveObservationRow } from '../types';

let seq = 0;
function row(patch: Partial<ObserveObservationRow>): ObserveObservationRow {
  seq += 1;
  return {
    obs_id: `obs-${seq}`,
    trace_id: 'trace-1',
    session_id: null,
    agent_id: 'agent-1',
    parent_obs_id: null,
    kind: 'span',
    name: null,
    start: 0,
    end: null,
    status: 'ok',
    input: null,
    output: null,
    model: null,
    usage_input_tokens: null,
    usage_output_tokens: null,
    usage_cached_tokens: null,
    usage_reasoning_tokens: null,
    cost_usd: null,
    cost_partial: null,
    usage_estimated: null,
    truncated: false,
    attrs: null,
    ...patch,
  };
}

describe('nestObservations', () => {
  it('nests children under their parent_obs_id, roots sorted by start', () => {
    const root = row({ obs_id: 'root', start: 100 });
    const childB = row({ obs_id: 'child-b', parent_obs_id: 'root', start: 300 });
    const childA = row({ obs_id: 'child-a', parent_obs_id: 'root', start: 200 });
    const grand = row({ obs_id: 'grand', parent_obs_id: 'child-a', start: 250 });
    // Rows arrive flat ordered by start, but order must not matter to the tree.
    const tree = nestObservations([root, childA, grand, childB]);
    expect(tree.map((n) => n.row.obs_id)).toEqual(['root']);
    expect(tree[0].children.map((n) => n.row.obs_id)).toEqual(['child-a', 'child-b']);
    expect(tree[0].children[0].children.map((n) => n.row.obs_id)).toEqual(['grand']);
    expect(grand && tree[0].children[0].children[0].depth).toBe(2);
  });

  it('keeps multiple roots in start order', () => {
    const later = row({ obs_id: 'later', start: 500 });
    const earlier = row({ obs_id: 'earlier', start: 100 });
    expect(nestObservations([later, earlier]).map((n) => n.row.obs_id)).toEqual(['earlier', 'later']);
  });

  it('hoists orphans whose parent_obs_id is missing instead of dropping them', () => {
    const root = row({ obs_id: 'root', start: 0 });
    const orphan = row({ obs_id: 'orphan', parent_obs_id: 'gone', start: 50 });
    const tree = nestObservations([root, orphan]);
    expect(tree.map((n) => n.row.obs_id)).toEqual(['root', 'orphan']);
    expect(tree[1].depth).toBe(0);
  });

  it('treats a self-parent as a root and survives parent/child cycles', () => {
    const selfish = row({ obs_id: 'self', parent_obs_id: 'self', start: 0 });
    const a = row({ obs_id: 'a', parent_obs_id: 'b', start: 10 });
    const b = row({ obs_id: 'b', parent_obs_id: 'a', start: 20 });
    const tree = nestObservations([selfish, a, b]);
    // Both rows are reachable somewhere at root level - nothing is dropped.
    const flat = flattenObservationTree(tree);
    expect(flat.map((n) => n.row.obs_id).sort()).toEqual(['a', 'b', 'self']);
  });

  it('flattenObservationTree is depth-first with depth values', () => {
    const root = row({ obs_id: 'root', start: 0 });
    const child = row({ obs_id: 'child', parent_obs_id: 'root', start: 10 });
    const sibling = row({ obs_id: 'sibling', start: 20 });
    const flat = flattenObservationTree(nestObservations([sibling, child, root]));
    expect(flat.map((n) => [n.row.obs_id, n.depth])).toEqual([
      ['root', 0],
      ['child', 1],
      ['sibling', 0],
    ]);
  });
});

describe('traceBounds', () => {
  it('spans min start to max end, counting unfinished rows to now', () => {
    const bounds = traceBounds(
      [row({ start: 100, end: 400 }), row({ start: 200, end: null })],
      1000
    );
    expect(bounds).toEqual({ minStart: 100, maxEnd: 1000 });
  });

  it('is degenerate-safe on empty input', () => {
    expect(traceBounds([])).toEqual({ minStart: 0, maxEnd: 1 });
  });
});
