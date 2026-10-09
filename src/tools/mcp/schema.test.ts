import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { jsonSchemaToZod } from './schema';

describe('jsonSchemaToZod', () => {
  const cases: Array<{
    name: string;
    schema: unknown;
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

  // LOU-Z1: these used to throw; conversion is now permissive and never throws.
  it('falls back to z.any() for an unresolvable $ref', () => {
    const zodSchema = jsonSchemaToZod({ $ref: '#/definitions/Missing' });
    expect(zodSchema.safeParse({ anything: 1 }).success).toBe(true);
  });

  it('resolves a recursive $ref one level and uses z.any() for the inner occurrence', () => {
    const zodSchema = jsonSchemaToZod({
      $ref: '#/definitions/Node',
      definitions: {
        Node: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            children: { type: 'array', items: { $ref: '#/definitions/Node' } },
          },
          required: ['name'],
        },
      },
    });
    expect(zodSchema.safeParse({ name: 'a', children: [{ name: 'b', children: [{}] }] }).success).toBe(
      true
    );
    expect(zodSchema.safeParse({ children: [] }).success).toBe(false);
  });

  it('maps type "null" to z.null()', () => {
    const zodSchema = jsonSchemaToZod({ type: 'null' });
    expect(zodSchema.safeParse(null).success).toBe(true);
    expect(zodSchema.safeParse(1).success).toBe(false);
  });
});

describe('jsonSchemaToZod (LOU-Z1 features)', () => {
  const accepts = (schema: unknown, value: unknown) => jsonSchemaToZod(schema).safeParse(value).success;

  it('treats unknown, empty and boolean schemas as z.any()', () => {
    for (const schema of [{}, true, false, undefined, null, { type: 'weird' }, { format: 'uri', foo: 1 }]) {
      expect(accepts(schema, { x: 1 })).toBe(true);
    }
  });

  it('converts the nullable anyOf pattern with .nullable()', () => {
    const schema = { anyOf: [{ type: 'string' }, { type: 'null' }] };
    expect(accepts(schema, 'a')).toBe(true);
    expect(accepts(schema, null)).toBe(true);
    expect(accepts(schema, 1)).toBe(false);
  });

  it('converts anyOf / oneOf to a union', () => {
    for (const key of ['anyOf', 'oneOf']) {
      const schema = { [key]: [{ type: 'string' }, { type: 'integer' }] };
      expect(accepts(schema, 'a')).toBe(true);
      expect(accepts(schema, 2)).toBe(true);
      expect(accepts(schema, true)).toBe(false);
    }
  });

  it('Eve TOOLS-F4: keeps an object schema whose sibling oneOf/anyOf only adds required branches', () => {
    const base = {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'integer' }, title: { type: 'string' } },
      required: ['owner', 'repo'],
    };
    for (const key of ['oneOf', 'anyOf']) {
      const zodSchema = jsonSchemaToZod({ ...base, [key]: [{ required: ['issue_number'] }, { required: ['title'] }] });
      expect(zodSchema).toBeInstanceOf(z.ZodObject);
      expect(Object.keys((zodSchema as unknown as { shape: Record<string, unknown> }).shape)).toEqual(['owner', 'repo', 'issue_number', 'title']);
      expect(zodSchema.safeParse({ owner: 'o', repo: 'r', issue_number: 1 }).success).toBe(true);
      expect(zodSchema.safeParse({ owner: 42, bogus: 1 }).success).toBe(false);
      expect(zodSchema.safeParse({}).success).toBe(false);
    }
  });

  it('Eve TOOLS-F4: keeps the base object when sibling branches are full object schemas', () => {
    const zodSchema = jsonSchemaToZod({
      type: 'object',
      properties: { kind: { type: 'string' } },
      required: ['kind'],
      anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'number' } } }],
    });
    expect(zodSchema).toBeInstanceOf(z.ZodObject);
    expect(zodSchema.safeParse({ kind: 'x' }).success).toBe(true);
    expect(zodSchema.safeParse({}).success).toBe(false);
  });

  it('converts type arrays, including null', () => {
    const schema = { type: ['string', 'null'] };
    expect(accepts(schema, 'a')).toBe(true);
    expect(accepts(schema, null)).toBe(true);
    expect(accepts(schema, 1)).toBe(false);
    expect(accepts({ type: ['string', 'number'] }, 1)).toBe(true);
  });

  it('merges allOf object schemas', () => {
    const schema = {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
      ],
    };
    expect(accepts(schema, { a: 'x', b: 1 })).toBe(true);
    expect(accepts(schema, { a: 'x' })).toBe(false);
  });

  it('intersects allOf schemas that are not both objects', () => {
    const schema = { allOf: [{ type: 'string' }, { minLength: 2 }] };
    expect(accepts(schema, 'ab')).toBe(true);
    expect(accepts(schema, 1)).toBe(false);
  });

  it('resolves $ref into $defs and decodes JSON pointer escapes', () => {
    const schema = {
      type: 'object',
      properties: { who: { $ref: '#/$defs/a~1b' } },
      required: ['who'],
      $defs: { 'a/b': { type: 'string', enum: ['x', 'y'] } },
    };
    expect(accepts(schema, { who: 'x' })).toBe(true);
    expect(accepts(schema, { who: 'z' })).toBe(false);
  });

  it('falls back to z.any() for a non-local $ref and for self-reference', () => {
    expect(accepts({ $ref: 'https://example.com/s.json' }, 1)).toBe(true);
    expect(accepts({ $ref: '#' }, 1)).toBe(true);
  });

  it('supports enum with mixed types and const', () => {
    expect(accepts({ enum: ['a', 1, null, true] }, null)).toBe(true);
    expect(accepts({ enum: ['a', 1, null, true] }, 1)).toBe(true);
    expect(accepts({ enum: ['a', 1, null, true] }, 2)).toBe(false);
    expect(accepts({ const: 'fixed' }, 'fixed')).toBe(true);
    expect(accepts({ const: 'fixed' }, 'other')).toBe(false);
    expect(accepts({ const: { a: 1 } }, { a: 2 })).toBe(true); // object const: permissive
    expect(accepts({ enum: [] }, 'anything')).toBe(true);
  });

  it('handles additionalProperties as boolean and as a schema', () => {
    const base = { type: 'object', properties: { a: { type: 'string' } } };
    expect(accepts(base, { a: 'x', extra: 1 })).toBe(true);
    expect(jsonSchemaToZod(base).parse({ a: 'x', extra: 1 })).toEqual({ a: 'x', extra: 1 });
    expect(accepts({ ...base, additionalProperties: true }, { extra: 1 })).toBe(true);
    expect(accepts({ ...base, additionalProperties: false }, { extra: 1 })).toBe(false);
    const typed = { ...base, additionalProperties: { type: 'number' } };
    expect(accepts(typed, { a: 'x', n: 1 })).toBe(true);
    expect(accepts(typed, { a: 'x', n: 'no' })).toBe(false);
  });

  it('applies defaults so omitted values are filled in', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { limit: { type: 'integer', default: 10 } },
    });
    expect(schema.parse({})).toEqual({ limit: 10 });
  });

  it('enforces the constraints zod can express', () => {
    expect(accepts({ type: 'string', minLength: 2, maxLength: 3 }, 'abcd')).toBe(false);
    expect(accepts({ type: 'string', minLength: 2, maxLength: 3 }, 'abc')).toBe(true);
    expect(accepts({ type: 'string', pattern: '^[a-z]+$' }, 'abc')).toBe(true);
    expect(accepts({ type: 'string', pattern: '^[a-z]+$' }, 'ABC')).toBe(false);
    expect(accepts({ type: 'number', minimum: 1, maximum: 5 }, 6)).toBe(false);
    expect(accepts({ type: 'number', exclusiveMinimum: 1 }, 1)).toBe(false);
    expect(accepts({ type: 'number', exclusiveMaximum: 1 }, 0)).toBe(true);
    expect(accepts({ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 }, [])).toBe(false);
    expect(accepts({ type: 'array', maxItems: 1 }, [1, 2])).toBe(false);
  });

  it('skips an invalid regex pattern instead of throwing', () => {
    expect(accepts({ type: 'string', pattern: '([unclosed' }, 'anything')).toBe(true);
    expect(accepts({ type: 'string', pattern: 5 }, 'anything')).toBe(true);
  });

  it('is permissive for tuple items, missing items and untyped properties', () => {
    expect(accepts({ type: 'array', items: [{ type: 'string' }] }, [1, 'a'])).toBe(true);
    expect(accepts({ type: 'array' }, [1, 'a'])).toBe(true);
    expect(accepts({ properties: { a: { type: 'string' } } }, { a: 'x' })).toBe(true);
    expect(accepts({ items: { type: 'string' } }, ['x'])).toBe(true);
  });

  it('carries the description through', () => {
    expect(jsonSchemaToZod({ type: 'string', description: 'A name' }).description).toBe('A name');
  });

  it('stops at the depth limit instead of overflowing the stack', () => {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 200; i++) schema = { type: 'array', items: schema };
    expect(() => jsonSchemaToZod(schema)).not.toThrow();
  });
});

describe('jsonSchemaToZod accepts documented payloads of popular MCP servers', () => {
  const accepts = (schema: unknown, value: unknown) => jsonSchemaToZod(schema).safeParse(value).success;

  it('filesystem read_file (path, optional head/tail, $schema keyword)', () => {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        tail: { type: 'number', description: 'last N lines' },
        head: { type: 'number', description: 'first N lines' },
      },
      required: ['path'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    };
    expect(accepts(schema, { path: '/tmp/a.txt' })).toBe(true);
    expect(accepts(schema, { path: '/tmp/a.txt', head: 10 })).toBe(true);
    expect(accepts(schema, { head: 10 })).toBe(false);
  });

  it('GitHub create_issue (optional arrays, nullable fields, numeric milestone)', () => {
    const schema = {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: ['string', 'null'] },
        assignees: { type: 'array', items: { type: 'string' } },
        labels: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
        milestone: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      },
      required: ['owner', 'repo', 'title'],
    };
    expect(accepts(schema, { owner: 'o', repo: 'r', title: 't' })).toBe(true);
    expect(
      accepts(schema, {
        owner: 'o',
        repo: 'r',
        title: 't',
        body: null,
        assignees: ['me'],
        labels: ['bug'],
        milestone: null,
      })
    ).toBe(true);
    expect(accepts(schema, { owner: 'o', repo: 'r' })).toBe(false);
  });

  it('a $ref/$defs schema (search with shared filter definition)', () => {
    const schema = {
      type: 'object',
      properties: {
        query: { type: 'string' },
        filters: { type: 'array', items: { $ref: '#/$defs/Filter' } },
        sort: { $ref: '#/$defs/Sort' },
      },
      required: ['query'],
      $defs: {
        Filter: {
          type: 'object',
          properties: { field: { type: 'string' }, value: { type: ['string', 'number', 'boolean'] } },
          required: ['field', 'value'],
        },
        Sort: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
      },
    };
    expect(accepts(schema, { query: 'q' })).toBe(true);
    expect(accepts(schema, { query: 'q', filters: [{ field: 'state', value: 'open' }], sort: 'desc' })).toBe(
      true
    );
    expect(accepts(schema, { query: 'q', filters: [{ field: 'state' }] })).toBe(false);
  });
});
