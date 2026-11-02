import { describe, expect, it } from 'vitest';
import {
  authorDraftSchema,
  authorPatchSchema,
  DRAFT_OMITTED_KEYS,
  FIELD_DESCRIPTIONS,
  NULLABLE_PATCH_KEYS,
} from '../schema';

/**
 * The draft/patch zod contracts of the Author's propose tools: which keys
 * a draft must, may and must not carry; the patch's optional/nullable
 * rules; and the `.describe()` coverage the model-facing JSON Schema
 * depends on (a spec key added without a FIELD_DESCRIPTIONS row fails
 * here, which is the point - the model only ever sees descriptions).
 */

const MINIMAL_DRAFT = {
  name: 'Support triage',
  description: 'Routes support mail to the right queue.',
  model: 'anthropic/claude-sonnet-5-5',
  instructions: 'You triage support mail and pick the queue.',
};

describe('authorDraftSchema', () => {
  it('accepts a minimal valid draft', () => {
    const parsed = authorDraftSchema.safeParse(MINIMAL_DRAFT);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(MINIMAL_DRAFT);
    }
  });

  it.each(['name', 'description', 'model', 'instructions'])('requires %s', (key) => {
    const draft = { ...MINIMAL_DRAFT } as Record<string, unknown>;
    delete draft[key];
    expect(authorDraftSchema.safeParse(draft).success).toBe(false);
  });

  it.each([...DRAFT_OMITTED_KEYS, 'labels', 'bogusField'])('rejects the never-settable key %s', (key) => {
    expect(authorDraftSchema.safeParse({ ...MINIMAL_DRAFT, [key]: 'x' }).success).toBe(false);
  });

  it('requires description, capped at 500 characters', () => {
    expect(authorDraftSchema.safeParse({ ...MINIMAL_DRAFT, description: '' }).success).toBe(false);
    expect(authorDraftSchema.safeParse({ ...MINIMAL_DRAFT, description: 'x'.repeat(501) }).success).toBe(false);
    expect(authorDraftSchema.safeParse({ ...MINIMAL_DRAFT, description: 'x'.repeat(500) }).success).toBe(true);
  });

  it('takes instructions as a string only, never { file }', () => {
    expect(authorDraftSchema.safeParse({ ...MINIMAL_DRAFT, instructions: { file: 'prompt.md' } }).success).toBe(false);
    expect(authorDraftSchema.safeParse({ ...MINIMAL_DRAFT, instructions: '' }).success).toBe(false);
  });

  it('validates fields with the spec rules (model id shape, name shape)', () => {
    expect(authorDraftSchema.safeParse({ ...MINIMAL_DRAFT, model: 'claude' }).success).toBe(false);
    expect(authorDraftSchema.safeParse({ ...MINIMAL_DRAFT, name: '!!!' }).success).toBe(false);
  });
});

describe('authorPatchSchema', () => {
  it('accepts an empty patch and every draft key on its own', () => {
    expect(authorPatchSchema.safeParse({}).success).toBe(true);
    for (const key of Object.keys(authorDraftSchema.shape)) {
      const patch: Record<string, unknown> = {};
      patch[key] = undefined;
      expect(authorPatchSchema.safeParse(patch).success).toBe(true);
    }
  });

  it.each(['version', 'evals', 'flow', 'bogusField'])('rejects the unknown key %s', (key) => {
    expect(authorPatchSchema.safeParse({ [key]: 'x' }).success).toBe(false);
  });

  it('keeps null in the parsed patch so the apply step can reset the field', () => {
    const parsed = authorPatchSchema.safeParse({ reasoning: null });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.reasoning).toBeNull();
  });

  it('accepts null on every spec-optional field except description', () => {
    for (const key of NULLABLE_PATCH_KEYS.filter((key) => key in authorDraftSchema.shape)) {
      expect(authorPatchSchema.safeParse({ [key]: null }).success).toBe(true);
    }
  });

  it.each(['description', 'name', 'model', 'instructions'])('rejects null on %s', (key) => {
    expect(authorPatchSchema.safeParse({ [key]: null }).success).toBe(false);
  });

  it('still validates a provided value (clearing a list, replacing a field)', () => {
    expect(authorPatchSchema.safeParse({ tools: [] }).success).toBe(true);
    expect(authorPatchSchema.safeParse({ tools: 'many' }).success).toBe(false);
    expect(authorPatchSchema.safeParse({ model: 'claude' }).success).toBe(false);
  });
});

describe('NULLABLE_PATCH_KEYS', () => {
  it('covers the spec-optional keys a reset makes sense for', () => {
    for (const key of ['reasoning', 'tools', 'triggers', 'mcpServers', 'promptCaching', 'fallbackModels']) {
      expect(NULLABLE_PATCH_KEYS).toContain(key);
    }
  });

  it('excludes description and the required fields', () => {
    for (const key of ['description', 'name', 'model', 'instructions', 'version']) {
      expect(NULLABLE_PATCH_KEYS).not.toContain(key);
    }
  });
});

describe('describe coverage', () => {
  it('FIELD_DESCRIPTIONS covers exactly the draft keys', () => {
    expect(Object.keys(FIELD_DESCRIPTIONS).sort()).toEqual(Object.keys(authorDraftSchema.shape).sort());
  });

  it('authorPatchSchema has the same keys as the draft schema', () => {
    expect(Object.keys(authorPatchSchema.shape).sort()).toEqual(Object.keys(authorDraftSchema.shape).sort());
  });

  it.each(Object.keys(authorDraftSchema.shape))('draft field %s is described', (key) => {
    expect(authorDraftSchema.shape[key]?.description).toBe(FIELD_DESCRIPTIONS[key]);
  });

  it.each(Object.keys(authorPatchSchema.shape))('patch field %s is described', (key) => {
    expect(authorPatchSchema.shape[key]?.description).toBe(FIELD_DESCRIPTIONS[key]);
  });
});
