import { describe, expect, it } from 'vitest';

import { fromRows, toRows, type WhenRow } from '../whenRows';

describe('toRows', () => {
  it('maps a plain string matcher to a pattern row', () => {
    expect(toRows({ url: '^https://internal\\.' })).toStrictEqual([
      { arg: 'url', op: 'pattern', value: '^https://internal\\.' },
    ]);
  });

  it.each([
    [{ eq: 'fast' }, 'fast'],
    [{ eq: 5 }, '5'],
    [{ eq: true }, 'true'],
    [{ eq: null }, 'null'],
    [{ ne: 'x' }, 'x'],
    [{ lt: 1 }, '1'],
    [{ lte: 2.5 }, '2.5'],
    [{ gt: 0 }, '0'],
    [{ gte: -1 }, '-1'],
    [{ matches: '^a+$' }, '^a+$'],
  ] as const)('maps the operator object %j to one row', (matcher, value) => {
    const [key] = Object.entries(matcher)[0];
    expect(toRows({ n: matcher as never })).toStrictEqual([{ arg: 'n', op: key, value }]);
  });

  it('shows one row per operator for a multi-operator argument', () => {
    expect(toRows({ n: { gt: 1, lt: 5 } })).toStrictEqual([
      { arg: 'n', op: 'gt', value: '1' },
      { arg: 'n', op: 'lt', value: '5' },
    ]);
  });

  it('keeps the when entry order across arguments', () => {
    expect(toRows({ b: 'x', a: { eq: 1 } })).toStrictEqual([
      { arg: 'b', op: 'pattern', value: 'x' },
      { arg: 'a', op: 'eq', value: '1' },
    ]);
  });

  it('returns no rows for undefined', () => {
    expect(toRows(undefined)).toStrictEqual([]);
  });
});

describe('fromRows', () => {
  const ok = (rows: WhenRow[]) => fromRows(rows).when;

  it('round-trips the plain-string pattern', () => {
    expect(ok([{ arg: 'url', op: 'pattern', value: '^https://' }])).toStrictEqual({
      url: '^https://',
    });
  });

  it.each([
    [{ arg: 'n', op: 'eq', value: 'true' } as WhenRow, { eq: true }],
    [{ arg: 'n', op: 'eq', value: 'false' } as WhenRow, { eq: false }],
    [{ arg: 'n', op: 'eq', value: 'null' } as WhenRow, { eq: null }],
    [{ arg: 'n', op: 'eq', value: '5' } as WhenRow, { eq: 5 }],
    [{ arg: 'n', op: 'eq', value: '-2.5' } as WhenRow, { eq: -2.5 }],
    [{ arg: 'n', op: 'eq', value: 'fast' } as WhenRow, { eq: 'fast' }],
    [{ arg: 'n', op: 'ne', value: '0' } as WhenRow, { ne: 0 }],
    [{ arg: 'n', op: 'lt', value: '5' } as WhenRow, { lt: 5 }],
    [{ arg: 'n', op: 'matches', value: '^a+$' } as WhenRow, { matches: '^a+$' }],
  ])('writes %j as %j', (row, matcher) => {
    expect(ok([row])).toStrictEqual({ n: matcher });
  });

  it('merges same-argument rows back into one operator object', () => {
    const rows = toRows({ n: { gt: 1, lt: 5 } });
    expect(ok(rows)).toStrictEqual({ n: { gt: 1, lt: 5 } });
  });

  it('merges a pattern row with operators into the matches key', () => {
    expect(
      ok([
        { arg: 'n', op: 'pattern', value: '^a' },
        { arg: 'n', op: 'lt', value: '5' },
      ]),
    ).toStrictEqual({ n: { matches: '^a', lt: 5 } });
  });

  it('keeps argument order', () => {
    expect(
      ok([
        { arg: 'b', op: 'eq', value: '1' },
        { arg: 'a', op: 'gt', value: '2' },
      ]),
    ).toStrictEqual({ b: { eq: 1 }, a: { gt: 2 } });
  });

  it('returns undefined when for no rows', () => {
    expect(ok([])).toBeUndefined();
  });
});

describe('fromRows row errors', () => {
  it('flags an empty argument name', () => {
    const parsed = fromRows([{ arg: '', op: 'eq', value: '1' }]);
    expect(parsed.errors).toStrictEqual(['A condition needs an argument name']);
    expect(parsed.when).toBeUndefined();
  });

  it.each(['lt', 'lte', 'gt', 'gte'] as const)('flags a non-number for %s', (op) => {
    const parsed = fromRows([{ arg: 'n', op, value: 'abc' }]);
    expect(parsed.errors).toStrictEqual(['Enter a number']);
    expect(parsed.when).toBeUndefined();
  });

  it('flags a matches value that does not compile', () => {
    const parsed = fromRows([{ arg: 'url', op: 'matches', value: '[' }]);
    expect(parsed.errors).toStrictEqual(['This is not a valid regular expression']);
    expect(parsed.when).toBeUndefined();
  });

  it('does not flag a pattern value that does not compile', () => {
    const parsed = fromRows([{ arg: 'url', op: 'pattern', value: '[' }]);
    expect(parsed.errors).toStrictEqual([undefined]);
    expect(parsed.when).toStrictEqual({ url: '[' });
  });

  it('reports errors per row, keeping the valid rows valid', () => {
    const parsed = fromRows([
      { arg: 'a', op: 'eq', value: '1' },
      { arg: 'b', op: 'matches', value: '(' },
    ]);
    expect(parsed.errors).toStrictEqual([undefined, 'This is not a valid regular expression']);
  });
});
