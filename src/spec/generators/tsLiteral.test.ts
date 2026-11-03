import { describe, expect, it } from 'vitest';
import { toTsLiteral, tsObjectKey } from './tsLiteral';

describe('toTsLiteral', () => {
  it('prints strings single-quoted and escapes backslashes, quotes and newlines', () => {
    expect(toTsLiteral('plain', 0)).toBe("'plain'");
    expect(toTsLiteral("it's \\ fine", 0)).toBe("'it\\'s \\\\ fine'");
    expect(toTsLiteral('a\nb', 0)).toBe("'a\\nb'");
  });

  it('prints null, numbers and booleans as their JS source', () => {
    expect(toTsLiteral(null, 0)).toBe('null');
    expect(toTsLiteral(42, 0)).toBe('42');
    expect(toTsLiteral(0.5, 0)).toBe('0.5');
    expect(toTsLiteral(true, 0)).toBe('true');
    expect(toTsLiteral(false, 0)).toBe('false');
  });

  it('keeps identifier-safe keys bare and quotes the rest', () => {
    expect(toTsLiteral({ a: 1, 'a-b': 2, 'with space': 3, _ok: 4, $d: 5 }, 0)).toBe(
      "{ a: 1, 'a-b': 2, 'with space': 3, _ok: 4, $d: 5 }"
    );
  });

  it('prints nested objects and arrays inline while they fit in 80 columns', () => {
    expect(toTsLiteral({ list: [1, { two: 2 }], empty: {}, none: [] }, 0)).toBe('{ list: [1, { two: 2 }], empty: {}, none: [] }');
  });

  it('wraps an object one property per line past 80 columns, counting the indent', () => {
    const value = { first: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', second: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    expect(toTsLiteral(value, 0)).toBe(
      "{\n  first: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',\n  second: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',\n}"
    );
  });

  it('wraps an array one element per line and indents nested blocks under it', () => {
    const value = ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccc'];
    expect(toTsLiteral(value, 2)).toBe(
      "[\n    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',\n    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',\n    'cccccccc',\n  ]"
    );
  });

  it('wraps a nested value inside a wrapped object without losing inner indentation', () => {
    const value = { outer: { a: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', b: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } };
    expect(toTsLiteral(value, 0)).toBe(
      "{\n  outer: {\n    a: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',\n    b: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',\n  },\n}"
    );
  });
});

describe('tsObjectKey', () => {
  it('returns identifier-safe keys bare and quotes the rest', () => {
    expect(tsObjectKey('name')).toBe('name');
    expect(tsObjectKey('a-b')).toBe("'a-b'");
    expect(tsObjectKey('2bad')).toBe("'2bad'");
  });
});
