/**
 * `toolParametersToJsonSchema` conversion coverage. The zod 3 path is
 * exercised through hand-built `{ _def }` fixtures rather than real `zod`
 * schemas so the assertions hold under every peer matrix install (zod 3 and
 * zod 4 produce different `_def`/`_zod` internals for the same source).
 */

import { describe, expect, it } from 'vitest';
import { toolParametersToJsonSchema } from './schema';

/** A minimal zod 3 node: `typeName` plus whichever `_def` fields the fixture needs. */
const z3 = (typeName: string, def: Record<string, unknown> = {}) => ({ _def: { typeName, ...def } });

describe('toolParametersToJsonSchema - entry handling', () => {
  it('returns undefined for non-schema input', () => {
    expect(toolParametersToJsonSchema(undefined)).toBeUndefined();
    expect(toolParametersToJsonSchema(null)).toBeUndefined();
    expect(toolParametersToJsonSchema('nope')).toBeUndefined();
    expect(toolParametersToJsonSchema(42)).toBeUndefined();
  });

  it('passes a plain JSON-Schema object through untouched', () => {
    const raw = { type: 'object', properties: { q: { type: 'string' } } };
    expect(toolParametersToJsonSchema(raw)).toBe(raw);
  });

  it("unwraps an 'ai' jsonSchema() wrapper to its .jsonSchema", () => {
    const inner = { type: 'object', properties: { n: { type: 'number' } } };
    expect(toolParametersToJsonSchema({ jsonSchema: inner, validate: () => ({ success: true }) })).toBe(inner);
  });

  it('caches per schema object (second call returns the same reference)', () => {
    const schema = z3('ZodString');
    expect(toolParametersToJsonSchema(schema)).toBe(toolParametersToJsonSchema(schema));
  });
});

describe('toolParametersToJsonSchema - zod 3 scalar kinds', () => {
  it('maps the plain scalar types', () => {
    expect(toolParametersToJsonSchema(z3('ZodString'))).toEqual({ type: 'string' });
    expect(toolParametersToJsonSchema(z3('ZodNumber'))).toEqual({ type: 'number' });
    expect(toolParametersToJsonSchema(z3('ZodBoolean'))).toEqual({ type: 'boolean' });
    expect(toolParametersToJsonSchema(z3('ZodBigInt'))).toEqual({ type: 'integer' });
    expect(toolParametersToJsonSchema(z3('ZodDate'))).toEqual({ type: 'string', format: 'date-time' });
    expect(toolParametersToJsonSchema(z3('ZodNull'))).toEqual({ type: 'null' });
    expect(toolParametersToJsonSchema(z3('ZodAny'))).toEqual({});
    expect(toolParametersToJsonSchema(z3('ZodUnknown'))).toEqual({});
  });

  it('maps void/undefined/never to a rejecting schema', () => {
    for (const typeName of ['ZodUndefined', 'ZodVoid', 'ZodNever']) {
      expect(toolParametersToJsonSchema(z3(typeName))).toEqual({ not: {} });
    }
  });

  it('maps enum, native enum, and literal', () => {
    expect(toolParametersToJsonSchema(z3('ZodEnum', { values: ['a', 'b'] }))).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(toolParametersToJsonSchema(z3('ZodNativeEnum', { values: { A: 'a', B: 'b' } }))).toEqual({ enum: ['a', 'b'] });
    expect(toolParametersToJsonSchema(z3('ZodLiteral', { value: 'x' }))).toEqual({ const: 'x', enum: ['x'] });
  });

  it('carries the node description onto the JSON Schema', () => {
    expect(toolParametersToJsonSchema(z3('ZodString', { description: 'the name' }))).toEqual({ type: 'string', description: 'the name' });
  });

  it('collapses non-serializable kinds to the empty schema', () => {
    for (const typeName of ['ZodMap', 'ZodPromise', 'ZodLazy', 'ZodFunction', 'ZodNaN', 'ZodSymbol', 'ZodWhatever']) {
      expect(toolParametersToJsonSchema(z3(typeName))).toEqual({});
    }
  });
});

describe('toolParametersToJsonSchema - zod 3 checks', () => {
  it('bounds strings, numbers, and arrays with min/max', () => {
    expect(toolParametersToJsonSchema(z3('ZodString', { checks: [{ kind: 'min', value: 2 }, { kind: 'max', value: 9 }] }))).toEqual({
      type: 'string',
      minLength: 2,
      maxLength: 9,
    });
    expect(toolParametersToJsonSchema(z3('ZodNumber', { checks: [{ kind: 'min', value: 1 }, { kind: 'max', value: 5 }] }))).toEqual({
      type: 'number',
      minimum: 1,
      maximum: 5,
    });
    expect(toolParametersToJsonSchema(z3('ZodArray', { type: z3('ZodNumber'), checks: [{ kind: 'min', value: 1 }, { kind: 'max', value: 3 }] }))).toEqual({
      type: 'array',
      items: { type: 'number' },
      minItems: 1,
      maxItems: 3,
    });
  });

  it('honors exclusive bounds and the int/multiple_of/regex checks', () => {
    expect(
      toolParametersToJsonSchema(
        z3('ZodNumber', {
          checks: [
            { kind: 'min', value: 0, inclusive: false },
            { kind: 'int' },
            { kind: 'multiple_of', value: 3 },
          ],
        })
      )
    ).toEqual({ type: 'integer', exclusiveMinimum: 0, multipleOf: 3 });
    expect(toolParametersToJsonSchema(z3('ZodString', { checks: [{ kind: 'regex', regex: /^[a-z]+$/ }] }))).toEqual({
      type: 'string',
      pattern: '^[a-z]+$',
    });
  });

  it('maps format checks through, and ignores checks JSON Schema cannot express', () => {
    expect(toolParametersToJsonSchema(z3('ZodString', { checks: [{ kind: 'email' }] }))).toEqual({ type: 'string', format: 'email' });
    expect(toolParametersToJsonSchema(z3('ZodString', { checks: [{ kind: 'ip' }] }))).toEqual({ type: 'string', format: 'ip' });
    expect(toolParametersToJsonSchema(z3('ZodNumber', { checks: [{ kind: 'finite' }, { kind: 'mystery' }] }))).toEqual({ type: 'number' });
  });
});

describe('toolParametersToJsonSchema - zod 3 composite kinds', () => {
  it('unwraps optional/default/catch/readonly/branded to the inner schema', () => {
    for (const typeName of ['ZodOptional', 'ZodDefault', 'ZodCatch', 'ZodReadonly', 'ZodBranded']) {
      expect(toolParametersToJsonSchema(z3(typeName, { innerType: z3('ZodString') }))).toEqual({ type: 'string' });
    }
  });

  it('expresses nullable as an anyOf so null still validates', () => {
    expect(toolParametersToJsonSchema(z3('ZodNullable', { innerType: z3('ZodString') }))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
  });

  it('unwraps ZodEffects to the refined schema', () => {
    expect(toolParametersToJsonSchema(z3('ZodEffects', { schema: z3('ZodNumber') }))).toEqual({ type: 'number' });
    expect(toolParametersToJsonSchema(z3('ZodEffects', { innerType: z3('ZodBoolean') }))).toEqual({ type: 'boolean' });
  });

  it('builds objects with required fields detected through wrappers', () => {
    const shape = () => ({
      name: z3('ZodString'),
      nick: z3('ZodOptional', { innerType: z3('ZodString') }),
      score: z3('ZodDefault', { innerType: z3('ZodNumber') }),
      id: z3('ZodReadonly', { innerType: z3('ZodString') }),
    });
    expect(toolParametersToJsonSchema(z3('ZodObject', { shape }))).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        nick: { type: 'string' },
        score: { type: 'number' },
        id: { type: 'string' },
      },
      required: ['name', 'id'],
      additionalProperties: false,
    });
  });

  it('maps record, tuple, unions, intersection, and set', () => {
    expect(toolParametersToJsonSchema(z3('ZodRecord', { valueType: z3('ZodNumber') }))).toEqual({
      type: 'object',
      additionalProperties: { type: 'number' },
    });
    expect(toolParametersToJsonSchema(z3('ZodTuple', { items: [z3('ZodString'), z3('ZodNumber')] }))).toEqual({
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'number' }],
      minItems: 2,
      maxItems: 2,
    });
    expect(toolParametersToJsonSchema(z3('ZodUnion', { options: [z3('ZodString'), z3('ZodNumber')] }))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
    expect(toolParametersToJsonSchema(z3('ZodDiscriminatedUnion', { options: [z3('ZodObject', { shape: () => ({}) })] }))).toEqual({
      anyOf: [{ type: 'object', properties: {}, additionalProperties: false }],
    });
    expect(toolParametersToJsonSchema(z3('ZodIntersection', { left: z3('ZodString'), right: z3('ZodNumber') }))).toEqual({
      allOf: [{ type: 'string' }, { type: 'number' }],
    });
    expect(toolParametersToJsonSchema(z3('ZodSet', { valueType: z3('ZodString') }))).toEqual({
      type: 'array',
      uniqueItems: true,
      items: { type: 'string' },
    });
  });
});
