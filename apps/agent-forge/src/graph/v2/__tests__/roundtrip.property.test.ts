import { describe, expect, it } from 'vitest';

import { deriveEdges } from '../edges';
import { graphToSpec } from '../graphToSpec';
import { SPEC_KEY_ORDER } from '../order';
import { specToGraph } from '../specToGraph';
import { arbLayout, arbSpec } from './arbitraries';
import { mulberry32 } from './prng';

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

describe.each(SEEDS)('seed %i', (seed) => {
  const rng = mulberry32(seed);
  const spec = arbSpec(rng);
  const layout = arbLayout(rng, specToGraph(spec));
  const g1 = specToGraph(spec, layout);
  const r = graphToSpec(g1, spec);
  const g2 = specToGraph(r.spec, r.layout);

  it('P1 spec identity', () => {
    expect(r.spec).toStrictEqual(spec);
  });

  it('P2 key order', () => {
    expect(Object.keys(r.spec)).toEqual(Object.keys(spec));
    const fresh = graphToSpec(g1);
    const expected = [
      ...SPEC_KEY_ORDER.filter((key) => key in spec),
      ...Object.keys(spec).filter((key) => !SPEC_KEY_ORDER.includes(key)),
    ];
    expect(Object.keys(fresh.spec)).toEqual(expected);
  });

  it('P3 positions', () => {
    for (const id of Object.keys(layout.nodes)) {
      expect(r.layout.nodes[r.nodeIdMap[id]]).toStrictEqual(layout.nodes[id]);
    }
    expect(r.layout.notes).toStrictEqual(layout.notes);
    expect(r.layout.viewport).toStrictEqual(layout.viewport);
  });

  it('P4 graph fixpoint', () => {
    expect({ ...g2, unplaced: [] }).toStrictEqual({ ...g1, unplaced: [] });
    expect(g2.unplaced).toEqual([]);
  });

  it('P5 ids stable', () => {
    for (const [id, mapped] of Object.entries(r.nodeIdMap)) {
      expect(mapped, id).toBe(id);
    }
  });

  it('P6 edges', () => {
    expect(deriveEdges(g2)).toStrictEqual(deriveEdges(g1));
    const ids = new Set(g1.nodes.map((n) => n.id));
    const edgeIds = new Set<string>();
    for (const e of deriveEdges(g1)) {
      expect(ids.has(e.source), e.id).toBe(true);
      expect(ids.has(e.target), e.id).toBe(true);
      expect(edgeIds.has(e.id), e.id).toBe(false);
      edgeIds.add(e.id);
    }
  });
});
