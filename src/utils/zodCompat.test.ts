import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';
import { z as z4 } from 'zod/v4';
import { defineTool } from '../tools/defineTool';
import { validateToolArguments, ToolArgumentsValidationError } from '../execution/toolArgsValidation';
import { outputInstruction, validateOutput } from '../execution/structuredOutput';
import { stableStringify } from '../testing/fingerprint';
import type { ToolDescriptor } from '../types';
import {
  anyError,
  isModelSchema,
  isRawJsonSchema,
  issueMessage,
  issuePath,
  schemaToJsonSchema,
  typeErrors,
  type StandardSchemaV1,
} from './zodCompat';

/** A Standard Schema that is not zod: accepts strings, with an optional `~standard.jsonSchema`. */
function standardString(withJson: boolean): StandardSchemaV1<string> {
  const props = {
    version: 1 as const,
    vendor: 'test',
    validate: (value: unknown) =>
      typeof value === 'string' ? { value } : { issues: [{ message: 'not a string', path: [{ key: 'q' }] }] },
  };
  const jsonSchema = { input: () => ({ type: 'string' }) };
  return { '~standard': withJson ? { ...props, jsonSchema } : props } as StandardSchemaV1<string>;
}

// validateToolArguments reads only `inputSchema`; `tool` is a required ToolDescriptor field but unused here.
const descriptor = (inputSchema: unknown): ToolDescriptor => ({
  displayName: 't',
  inputSchema: inputSchema as StandardSchemaV1,
  tool: {} as unknown as ToolDescriptor['tool'],
});

describe('zodCompat (LOU-D29)', () => {
  it('converts zod 4 and Standard JSON Schemas, and leaves zod 3 to the ai SDK', () => {
    expect(schemaToJsonSchema(z4.object({ q: z4.string() }))).toMatchObject({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    });
    expect(schemaToJsonSchema(standardString(true))).toEqual({ type: 'string' });
    expect(schemaToJsonSchema(z3.object({ q: z3.string() }))).toBeUndefined();
    expect(schemaToJsonSchema({ type: 'object' })).toBeUndefined();
  });

  it('accepts zod 3, zod 4 and Standard JSON Schemas as model-facing schemas', () => {
    expect(isModelSchema(z3.string())).toBe(true);
    expect(isModelSchema(z4.string())).toBe(true);
    expect(isModelSchema(standardString(true))).toBe(true);
    expect(isModelSchema(standardString(false))).toBe(false);
    expect(isModelSchema({ type: 'object' })).toBe(false);
  });

  it('LOU-R4: recognizes a plain JSON-Schema object, but no schema form or wrapper', () => {
    expect(isRawJsonSchema({ type: 'object', properties: { q: { type: 'string' } } })).toBe(true);
    expect(isRawJsonSchema({})).toBe(true);
    // Every schema form the providers convert on their own stays untouched.
    expect(isRawJsonSchema(z3.string())).toBe(false);
    expect(isRawJsonSchema(z4.string())).toBe(false);
    expect(isRawJsonSchema(standardString(true))).toBe(false);
    expect(isRawJsonSchema(standardString(false))).toBe(false);
    // An 'ai' `jsonSchema()` wrapper already is a schema, not a raw one.
    expect(isRawJsonSchema({ jsonSchema: { type: 'object' }, validate: async () => ({ success: true, value: {} }) })).toBe(false);
    expect(isRawJsonSchema(undefined)).toBe(false);
    expect(isRawJsonSchema('object')).toBe(false);
    expect(isRawJsonSchema([])).toBe(false);
  });

  it('words type mismatches the same on both majors', () => {
    const v3 = z3.object({ a: z3.string(), b: z3.number() }).safeParse({ b: 'x' });
    const v4 = z4.object({ a: z4.string(), b: z4.number() }).safeParse({ b: 'x' });
    const words = (issues: ReadonlyArray<{ message: string; path: PropertyKey[] }>) =>
      issues.map((issue) => `${issuePath(issue)}: ${issueMessage(issue)}`);
    expect(words(v3.error!.issues)).toEqual(['a: Required', 'b: Expected number, received string']);
    expect(words(v4.error!.issues)).toEqual(words(v3.error!.issues));
    expect(issuePath({ message: 'm' })).toBe('(root)');
  });

  it('customizes errors in the installed major', () => {
    const name = z.string(typeErrors({ required: 'name is missing', invalid: 'name is not text' }));
    expect(name.safeParse(undefined).error?.issues[0].message).toBe('name is missing');
    expect(name.safeParse(1).error?.issues[0].message).toBe('name is not text');
    const flag = z.union([z.boolean(), z.literal('auto')], anyError('flag must be a boolean or auto'));
    expect(flag.safeParse(3).error?.issues[0].message).toBe('flag must be a boolean or auto');
  });

  it('defines and validates a tool with a zod 4 schema', async () => {
    const tool = defineTool({
      name: 'v4',
      description: 'd',
      input: z4.object({ q: z4.string(), n: z4.number().default(2) }),
      execute: ({ q, n }) => q.repeat(n),
    });
    await expect(validateToolArguments('v4', tool, { q: 'a' })).resolves.toEqual({ q: 'a', n: 2 });
    const error = await validateToolArguments('v4', tool, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolArgumentsValidationError);
    expect((error as ToolArgumentsValidationError).issues).toEqual([{ path: 'q', message: 'Required' }]);
  });

  it('validates with any Standard Schema, and only takes model-facing ones in defineTool', async () => {
    await expect(validateToolArguments('s', descriptor(standardString(false)), 'ok')).resolves.toBe('ok');
    const error = await validateToolArguments('s', descriptor(standardString(false)), 1).catch((e: unknown) => e);
    expect((error as ToolArgumentsValidationError).issues).toEqual([{ path: 'q', message: 'not a string' }]);
    expect(() => defineTool({ name: 's', description: 'd', input: standardString(false), execute: () => 1 })).toThrow(
      /zod schema as 'input'/
    );
    expect(defineTool({ name: 's', description: 'd', input: standardString(true), execute: (q) => q }).name).toBe('s');
  });

  it('asks for and validates structured output with a zod 4 schema', async () => {
    const schema = z4.object({ city: z4.string() }) as unknown as z.ZodTypeAny;
    expect(outputInstruction(schema)).toContain('"properties":{"city":{"type":"string"}}');
    await expect(validateOutput(schema, '{"city":"Oslo"}')).resolves.toEqual({ object: { city: 'Oslo' } });
    await expect(validateOutput(schema, '{}')).resolves.toMatchObject({ outputError: { issues: [{ path: 'city', message: 'Required' }] } });
  });

  it('fingerprints a zod 4 schema like the zod 3 one (cassettes replay under either)', () => {
    expect(stableStringify({ s: z4.object({ q: z4.string() }) })).toBe(stableStringify({ s: z3.object({ q: z3.string() }) }));
  });
});
