import { describe, it, expect } from 'vitest';
import { jsonSchemaToZod } from './schema';

describe('jsonSchemaToZod', () => {
  const cases: Array<{
    name: string;
    schema: any;
    valid: unknown[];
    invalid: unknown[];
  }> = [
    {
      name: 'object with required and optional fields',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
        required: ['name'],
      },
      valid: [{ name: 'a' }, { name: 'a', age: 5 }],
      invalid: [{}, { name: 'a', age: 'not-a-number' }, { age: 5 }],
    },
    {
      name: 'array of strings',
      schema: { type: 'array', items: { type: 'string' } },
      valid: [[], ['a', 'b']],
      invalid: [[1, 2], 'not-an-array'],
    },
    {
      name: 'string enum',
      schema: { type: 'string', enum: ['red', 'green', 'blue'] },
      valid: ['red', 'blue'],
      invalid: ['yellow', 1],
    },
    {
      name: 'number',
      schema: { type: 'number' },
      valid: [1, 1.5, -3],
      invalid: ['1', null],
    },
    {
      name: 'integer',
      schema: { type: 'integer' },
      valid: [1, -3],
      invalid: [1.5, '1'],
    },
    {
      name: 'boolean',
      schema: { type: 'boolean' },
      valid: [true, false],
      invalid: ['true', 1],
    },
    {
      name: 'nested object with array property',
      schema: {
        type: 'object',
        properties: {
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['tags'],
      },
      valid: [{ tags: ['a'] }],
      invalid: [{ tags: 'a' }, {}],
    },
  ];

  it.each(cases)('$name', ({ schema, valid, invalid }) => {
    const zodSchema = jsonSchemaToZod(schema);
    for (const sample of valid) {
      const result = zodSchema.safeParse(sample);
      expect(result.success, `expected valid: ${JSON.stringify(sample)}`).toBe(true);
    }
    for (const sample of invalid) {
      const result = zodSchema.safeParse(sample);
      expect(result.success, `expected invalid: ${JSON.stringify(sample)}`).toBe(false);
    }
  });

  it('marks non-required object fields optional', () => {
    const zodSchema = jsonSchemaToZod({
      type: 'object',
      properties: { name: { type: 'string' }, nickname: { type: 'string' } },
      required: ['name'],
    });
    const result = zodSchema.safeParse({ name: 'a' });
    expect(result.success).toBe(true);
  });

  it('throws for a $ref schema', () => {
    const schema = { $ref: '#/definitions/Node' };
    expect(() => jsonSchemaToZod(schema)).toThrow(/\$ref/);
  });

  it('throws for a recursive schema containing a nested $ref', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        children: {
          type: 'array',
          items: { $ref: '#/definitions/Node' },
        },
      },
      required: ['name'],
    };
    expect(() => jsonSchemaToZod(schema)).toThrow(/\$ref/);
  });

  it('throws for an unsupported schema type', () => {
    expect(() => jsonSchemaToZod({ type: 'null' })).toThrow(/unsupported/i);
  });
});
