import { describe, expect, it } from 'vitest';
import { SDKError } from '../execution/errors';
import { toWireJson } from './wireJson';

describe('toWireJson', () => {
  it('serializes plain values like JSON.stringify', () => {
    expect(toWireJson({ a: 1, b: 'x', c: [true, null] })).toBe('{"a":1,"b":"x","c":[true,null]}');
    expect(toWireJson('s')).toBe('"s"');
    expect(toWireJson(undefined)).toBe('null');
  });

  it('turns an Error into { name, message, code? }', () => {
    const plain = new Error('boom');
    expect(JSON.parse(toWireJson(plain))).toEqual({ name: 'Error', message: 'boom' });
    const coded = new SDKError('bad spec', 'LOUSHO_SPEC_INVALID');
    const wire = JSON.parse(toWireJson(coded)) as { name: string; message: string; code: string };
    expect(wire.name).toBe('SDKError');
    expect(wire.code).toBe('LOUSHO_SPEC_INVALID');
    expect(wire.message).toContain('bad spec');
  });

  it('stringifies bigint and base64s Uint8Array', () => {
    expect(JSON.parse(toWireJson({ n: 10n }))).toEqual({ n: '10' });
    expect(JSON.parse(toWireJson({ bytes: new Uint8Array([104, 105]) }))).toEqual({ bytes: 'aGk=' });
  });

  it('drops functions and symbols like undefined', () => {
    const out = JSON.parse(toWireJson({ f: () => 1, s: Symbol('x'), keep: 1 })) as Record<string, unknown>;
    expect(out).toEqual({ keep: 1 });
    // In arrays they become null, as JSON.stringify does.
    expect(JSON.parse(toWireJson([() => 1, undefined]))).toEqual([null, null]);
  });

  it("marks a circular reference '[Circular]' but repeats shared branches", () => {
    const shared = { v: 1 };
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic.self = cyclic;
    expect(JSON.parse(toWireJson(cyclic))).toEqual({ name: 'a', self: '[Circular]' });
    // The same object in two places is not a cycle.
    expect(JSON.parse(toWireJson({ left: shared, right: shared }))).toEqual({ left: { v: 1 }, right: { v: 1 } });
    // A cycle through an array is caught too.
    const arr: unknown[] = [];
    arr.push(arr);
    expect(JSON.parse(toWireJson(arr))).toEqual(['[Circular]']);
  });
});
