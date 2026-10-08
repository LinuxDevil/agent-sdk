/**
 * Eve PROV-F1/F2: the strict-schema rewrite (oneOf, records, tuples, a
 * non-object root) and the decode of a reply back to the schema's shape.
 */

import { describe, it, expect } from 'vitest';
import { decodeStrictValue, rewriteStrictShapes } from './strictShapes';

function rewrite(schema: Record<string, unknown>) {
  const strict = structuredClone(schema);
  const shapes = rewriteStrictShapes(strict);
  return { strict, decode: (value: unknown) => decodeStrictValue(value, strict, strict, shapes) };
}

describe('strictShapes (Eve PROV-F1)', () => {
  it('rewrites oneOf (zod 4 z.discriminatedUnion) to anyOf, nested and at the root', () => {
    const branch = (kind: string) => ({ type: 'object', properties: { kind: { const: kind } }, required: ['kind'], additionalProperties: false });
    const { strict, decode } = rewrite({ oneOf: [branch('a'), branch('b')] });

    expect(JSON.stringify(strict)).not.toContain('oneOf');
    expect(strict).toEqual({
      type: 'object',
      properties: { result: { anyOf: [branch('a'), branch('b')] } },
      required: ['result'],
      additionalProperties: false,
    });
    expect(decode({ result: { kind: 'b' } })).toEqual({ kind: 'b' });
  });

  it('keeps $schema and $defs at a wrapped root and retargets refs into the old root', () => {
    const { strict } = rewrite({
      $schema: 'http://json-schema.org/draft-07/schema#',
      anyOf: [{ type: 'object', properties: { next: { $ref: '#' } }, required: ['next'], additionalProperties: false }, { $ref: '#/$defs/leaf' }],
      $defs: { leaf: { type: 'string' } },
    });

    expect(strict.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(strict.$defs).toEqual({ leaf: { type: 'string' } });
    expect(JSON.stringify(strict)).toContain('"$ref":"#/properties/result"');
    expect(JSON.stringify(strict)).toContain('"$ref":"#/$defs/leaf"');
  });

  it('decodes a record in a union branch and a tuple with a rest element', () => {
    const { strict, decode } = rewrite({
      type: 'object',
      properties: {
        either: { anyOf: [{ type: 'object', additionalProperties: { type: 'number' } }, { type: 'null' }] },
        row: { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'number' } },
      },
      required: ['either', 'row'],
      additionalProperties: false,
    });

    const row = (strict.properties as Record<string, unknown>).row;
    expect(row).toEqual({
      type: 'object',
      properties: { _0: { type: 'string' }, _rest: { type: 'array', items: { type: 'number' } } },
      required: ['_0', '_rest'],
      additionalProperties: false,
    });
    expect(decode({ either: [{ key: 'x', value: 1 }], row: { _0: 'a', _rest: [1, 2] } })).toEqual({ either: { x: 1 }, row: ['a', 1, 2] });
    expect(decode({ either: null, row: { _0: 'a', _rest: [] } })).toEqual({ either: null, row: ['a'] });
  });

  it('leaves a plain object schema unchanged', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
    expect(rewrite(schema).strict).toEqual(schema);
  });
});
