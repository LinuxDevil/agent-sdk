import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOL_NAMES } from '../spec/v2/tools';
import { listBuiltinTools } from './catalog';

const byName = (name: string) => listBuiltinTools().find((entry) => entry.name === name);
const properties = (schema: Record<string, unknown> | null | undefined): Record<string, unknown> =>
  (schema?.properties ?? {}) as Record<string, unknown>;

describe('listBuiltinTools', () => {
  it('lists one entry per BUILTIN_TOOL_NAMES item, in the same order', () => {
    expect(listBuiltinTools().map((entry) => entry.name)).toEqual([...BUILTIN_TOOL_NAMES]);
  });

  it('describes web_fetch: read-only, one tool, url argument and options schema', () => {
    const entry = byName('web_fetch');
    expect(entry?.toolNames).toEqual(['web_fetch']);
    expect(entry?.mutating).toBe(false);
    expect(entry?.description.length).toBeGreaterThan(0);
    expect(entry?.inputJsonSchema.type).toBe('object');
    expect(properties(entry?.inputJsonSchema)).toHaveProperty('url');
    expect(properties(entry?.optionsJsonSchema)).toHaveProperty('maxChars');
  });

  it('marks http_request mutating and describes its options', () => {
    const entry = byName('http_request');
    expect(entry?.mutating).toBe(true);
    expect(properties(entry?.optionsJsonSchema)).toHaveProperty('allowPrivate');
  });

  it('reports todo as the todo_write/todo_read pair with no options', () => {
    const entry = byName('todo');
    expect(entry?.toolNames).toEqual(['todo_write', 'todo_read']);
    expect(entry?.optionsJsonSchema).toBeNull();
  });

  it('gives current_date an object input schema and no credentials', () => {
    const entry = byName('current_date');
    expect(entry?.inputJsonSchema.type).toBe('object');
    expect(entry?.needsCredentials).toEqual([]);
  });

  it('returns every inputJsonSchema as a draft-7 object schema', () => {
    for (const entry of listBuiltinTools()) {
      expect(entry.inputJsonSchema.type).toBe('object');
    }
  });

  it('returns equal results on repeated calls (no shared mutable state)', () => {
    expect(listBuiltinTools()).toEqual(listBuiltinTools());
  });
});
