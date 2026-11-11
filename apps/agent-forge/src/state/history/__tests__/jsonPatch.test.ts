import { describe, expect, it } from 'vitest';
import { applyPatch, diffJson, pointer, type PatchOp } from '../jsonPatch';
import { chance, int, mulberry32, pick } from '../../../graph/v2/__tests__/prng';

/** A random JSON value: leaves, arrays and objects with pointer-hostile keys. */
function randomJson(rng: () => number, depth: number): unknown {
  if (depth <= 0 || chance(rng, 0.4)) {
    return pick(rng, [null, true, false, int(rng, -100, 100), `s${int(rng, 0, 20)}`, rng() * 10]);
  }
  if (chance(rng, 0.5)) {
    return Array.from({ length: int(rng, 0, 5) }, () => randomJson(rng, depth - 1));
  }
  const keys = ['a', 'b c', 'x/y', 'til~de', '0', 'spec', 'tools[0]', ''];
  const out: Record<string, unknown> = {};
  for (let i = 0; i < int(rng, 0, 6); i++) {
    out[pick(rng, keys) + (chance(rng, 0.5) ? `_${int(rng, 0, 9)}` : '')] = randomJson(rng, depth - 1);
  }
  return out;
}

describe('pointer', () => {
  it('escapes ~ and / and joins segments', () => {
    expect(pointer([])).toBe('');
    expect(pointer(['spec'])).toBe('/spec');
    expect(pointer(['a/b', '~', 'c d', 3])).toBe('/a~1b/~0/c d/3');
  });
});

describe('diffJson/applyPatch', () => {
  it('round-trips 200 seeded random JSON pairs', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = mulberry32(seed);
      const a = randomJson(rng, 4);
      const b = randomJson(rng, 4);
      expect(applyPatch(a, diffJson(a, b))).toStrictEqual(b);
      expect(applyPatch(b, diffJson(b, a))).toStrictEqual(a);
    }
  });

  it('returns [] for structurally equal values regardless of key order', () => {
    expect(diffJson({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toEqual([]);
    expect(diffJson([1, [2, 3]], [1, [2, 3]])).toEqual([]);
  });

  it('replaces a whole subtree when the types differ', () => {
    const ops = diffJson({ a: { x: 1 } }, { a: [1, 2] });
    expect(ops).toEqual([{ op: 'replace', path: '/a', value: [1, 2] }]);
    expect(applyPatch({ a: { x: 1 } }, ops)).toEqual({ a: [1, 2] });
  });

  it('adds and removes array tails in apply order', () => {
    const a = [1, 2, 3, 4];
    const b = [1, 9];
    const ops = diffJson(a, b);
    expect(applyPatch(a, ops)).toEqual(b);
    expect(applyPatch(b, diffJson(b, a))).toEqual(a);
  });

  it('does not mutate its input', () => {
    const doc = { spec: { tools: [{ builtin: 'x' }] }, layout: { nodes: {} } };
    const before = JSON.parse(JSON.stringify(doc));
    applyPatch(doc, diffJson(doc, { spec: { tools: [] }, layout: { nodes: { n: { x: 1, y: 2 } } } }));
    expect(doc).toEqual(before);
  });

  it('escapes keys in emitted paths', () => {
    const ops = diffJson({}, { 'a/b': 1, 't~x': 2 });
    expect(ops.map((op) => op.path).sort()).toEqual(['/a~1b', '/t~0x']);
    expect(applyPatch({}, ops)).toEqual({ 'a/b': 1, 't~x': 2 });
  });
});

describe('applyPatch failures', () => {
  const missing: Array<[string, unknown, PatchOp[]]> = [
    ['replace a missing key', { a: 1 }, [{ op: 'replace', path: '/b', value: 2 }]],
    ['remove a missing key', { a: 1 }, [{ op: 'remove', path: '/b' }]],
    ['descend through a missing key', { a: 1 }, [{ op: 'replace', path: '/b/c', value: 2 }]],
    ['descend through a primitive', { a: 1 }, [{ op: 'replace', path: '/a/b', value: 2 }]],
    ['replace past an array end', { a: [1] }, [{ op: 'replace', path: '/a/3', value: 2 }]],
    ['remove past an array end', { a: [1] }, [{ op: 'remove', path: '/a/3' }]],
    ['a non-pointer path', { a: 1 }, [{ op: 'replace', path: 'a', value: 2 }]],
    ['remove the document root', { a: 1 }, [{ op: 'remove', path: '' }]],
  ];
  for (const [name, doc, ops] of missing) {
    it(`throws 'Patch does not apply' on ${name}`, () => {
      expect(() => applyPatch(doc, ops)).toThrowError(/^Patch does not apply: /);
    });
  }
});
