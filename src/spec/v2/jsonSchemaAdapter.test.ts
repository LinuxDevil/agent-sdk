/**
 * jsonSchemaToStandardSchema() / outputFromSpec(): a spec's plain JSON Schema
 * becomes a Standard Schema that validates through jsonSchemaToZod() and hands
 * providers the author's own schema back through schemaToJsonSchema(), so a v2
 * spec's `output: { jsonSchema }` drives createAgent({ output }) without zod.
 */
import { describe, it, expect } from 'vitest';
import { createAgent } from '../../createAgent';
import { mockModel } from '../../testing';
import { jsonSchemaToZod } from '../../tools/mcp/schema';
import { issueMessage, schemaToJsonSchema } from '../../utils/zodCompat';
import { jsonSchemaToStandardSchema, outputFromSpec } from './jsonSchemaAdapter';

const person = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };

async function validate(schema: Record<string, unknown>, value: unknown) {
  return jsonSchemaToStandardSchema(schema)['~standard'].validate(value);
}

describe('jsonSchemaToStandardSchema', () => {
  it("hands schemaToJsonSchema the author's own schema, as a copy", () => {
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

    const converted = schemaToJsonSchema(jsonSchemaToStandardSchema(schema));

    expect(converted).toEqual(schema);
    expect(converted).not.toBe(schema);
    expect(converted?.properties).not.toBe(schema.properties);
  });

  it('validates with the converted zod schema, reporting its issues with plain paths', async () => {
    const ok = await validate(person, { name: 'a' });
    expect(ok).toEqual({ value: { name: 'a' } });

    const bad = await validate(person, {});
    expect(bad.issues).toHaveLength(1);
    expect(bad.issues?.[0]?.path).toEqual(['name']);
  });

  it('drives createAgent({ output }) through outputFromSpec', async () => {
    const answer = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const agent = createAgent({
      provider: mockModel(['{"answer":"42"}']),
      instructions: 'x',
      output: outputFromSpec({ jsonSchema: answer }),
    });

    const result = await agent.send('go');

    expect(result.object).toEqual({ answer: '42' });
    expect(result.finishReason).toBe('stop');
  });

  it('validates nested arrays through items', async () => {
    const nested = {
      type: 'object',
      properties: { rows: { type: 'array', items: { type: 'array', items: { type: 'number' } } } },
      required: ['rows'],
    };

    const ok = await validate(nested, { rows: [[1, 2], [3]] });
    expect(ok.issues).toBeUndefined();

    const bad = await validate(nested, { rows: [[1, 'x']] });
    expect(bad.issues?.[0]?.path).toEqual(['rows', 0, 1]);
  });

  it("reports an enum failure with the converted zod schema's message", async () => {
    const enumSchema = { enum: ['a', 'b'] };
    const parsed = jsonSchemaToZod(enumSchema).safeParse('c');
    if (parsed.success) throw new Error('expected the converted zod schema to reject c');

    const bad = await validate(enumSchema, 'c');

    expect(bad.issues).toHaveLength(1);
    expect(bad.issues?.[0]?.message).toBe(issueMessage(parsed.error.issues[0] ?? { message: '' }));
  });

  it('returns a frozen object', () => {
    const adapter = jsonSchemaToStandardSchema(person);

    expect(Object.isFrozen(adapter)).toBe(true);
    expect(Object.isFrozen(adapter['~standard'])).toBe(true);
    expect(Object.isFrozen(adapter['~standard'].jsonSchema)).toBe(true);
  });
});

describe('outputFromSpec', () => {
  it('keeps promptSchema: false and responseFormat: always', () => {
    const spec = outputFromSpec({ jsonSchema: person, promptSchema: false, responseFormat: 'always' });

    expect(spec.promptSchema).toBe(false);
    expect(spec.responseFormat).toBe('always');
    expect(schemaToJsonSchema(spec.schema)).toEqual(person);
  });

  it('leaves the option keys out when the spec does not set them', () => {
    const spec = outputFromSpec({ jsonSchema: person });

    expect('promptSchema' in spec).toBe(false);
    expect('responseFormat' in spec).toBe(false);
  });
});
