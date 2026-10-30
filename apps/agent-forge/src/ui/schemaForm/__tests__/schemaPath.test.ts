import { describe, expect, it } from 'vitest';

import { getAtPath, pathKey, resolveRef, setAtPath } from '../schemaPath';
import type { JsonSchema } from '../types';

import { SCHEMA } from './fixture';

describe('pathKey', () => {
  it('joins string and number segments with dots', () => {
    expect(pathKey(['modelSettings', 'temperature'])).toBe('modelSettings.temperature');
    expect(pathKey(['tools', 0, 'id'])).toBe('tools.0.id');
    expect(pathKey([])).toBe('');
  });
});

describe('getAtPath', () => {
  it('reads nested values and returns undefined for missing or non-object segments', () => {
    expect(getAtPath({ a: { b: 2 } }, ['a', 'b'])).toBe(2);
    expect(getAtPath({ l: [1, 2] }, ['l', 1])).toBe(2);
    expect(getAtPath({ a: 1 }, ['a', 'b'])).toBeUndefined();
    expect(getAtPath(undefined, ['a'])).toBeUndefined();
    expect(getAtPath({ a: { b: 2 } }, [])).toEqual({ a: { b: 2 } });
  });
});

describe('setAtPath', () => {
  it('sets a nested value without mutating the input', () => {
    const input = { a: { b: 1 } };
    const next = setAtPath(input, ['a', 'b'], 2);
    expect(next).toEqual({ a: { b: 2 } });
    expect(input).toEqual({ a: { b: 1 } });
    expect(next).not.toBe(input);
  });

  it('deletes the key when next is undefined', () => {
    expect(setAtPath({ a: 1, b: 2 }, ['a'], undefined)).toEqual({ b: 2 });
  });

  it('creates missing containers along the path', () => {
    expect(setAtPath(undefined, ['x', 'y'], 1)).toEqual({ x: { y: 1 } });
  });

  it('updates array elements by index without changing length', () => {
    expect(setAtPath({ l: [1, 2] }, ['l', 1], 3)).toEqual({ l: [1, 3] });
  });
});

describe('resolveRef', () => {
  it('resolves #/definitions refs against the root schema', () => {
    const resolved = resolveRef(SCHEMA, { $ref: '#/definitions/settings' });
    expect(resolved.type).toBe('object');
    expect(resolved.properties?.temperature?.type).toBe('number');
  });

  it('resolves #/$defs refs and follows ref chains', () => {
    const root: JsonSchema = {
      $defs: {
        inner: { type: 'string' },
        outer: { $ref: '#/$defs/inner' },
      },
    };
    expect(resolveRef(root, { $ref: '#/$defs/outer' }).type).toBe('string');
  });

  it('returns {} for an unknown ref', () => {
    expect(resolveRef(SCHEMA, { $ref: '#/nope' })).toEqual({});
    expect(resolveRef(SCHEMA, { $ref: '#/definitions/missing' })).toEqual({});
  });
});
