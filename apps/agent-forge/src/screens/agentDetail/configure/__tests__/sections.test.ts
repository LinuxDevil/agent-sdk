import { describe, expect, it } from 'vitest';

import { agentSpecV2JsonSchema, type AgentSpecV2 } from 'lousho/spec';

import type { JsonSchema } from '../../../../ui/schemaForm/types';
import {
  CONFIGURE_HIDDEN_KEYS,
  CONFIGURE_SECTIONS,
  changedSections,
  sectionOf,
  sectionSchema,
} from '../sections';

const root = agentSpecV2JsonSchema() as unknown as JsonSchema;
const specKeys = Object.keys(root.properties ?? {});

describe('CONFIGURE_SECTIONS coverage', () => {
  it('places every top-level spec key in exactly one section or the hidden list', () => {
    const owners = new Map<string, number>();
    for (const section of CONFIGURE_SECTIONS) {
      for (const key of section.keys) owners.set(key, (owners.get(key) ?? 0) + 1);
    }
    for (const key of CONFIGURE_HIDDEN_KEYS) owners.set(key, (owners.get(key) ?? 0) + 1);
    for (const key of specKeys) {
      expect(owners.get(key), `spec key '${key}'`).toBe(1);
    }
    // And nothing else is claimed: every listed key is a real spec key.
    for (const key of owners.keys()) {
      expect(specKeys, `listed key '${key}'`).toContain(key);
    }
  });
});

describe('sectionSchema', () => {
  it('keeps only the requested properties, their required subset and the definitions', () => {
    const schema = sectionSchema(root, ['name', 'description']);
    expect(Object.keys(schema.properties ?? {})).toEqual(['name', 'description']);
    expect(schema.required ?? []).toEqual(
      (root.required ?? []).filter((key) => ['name', 'description'].includes(key)),
    );
    expect(schema.required ?? []).toSatisfy((req: string[]) =>
      req.every((key) => ['name', 'description'].includes(key)),
    );
    if (root.definitions !== undefined) expect(schema.definitions).toBe(root.definitions);
    if (root.$defs !== undefined) expect(schema.$defs).toBe(root.$defs);
  });

  it('drops properties the root schema does not have', () => {
    const schema = sectionSchema(root, ['name', 'notARealKey']);
    expect(Object.keys(schema.properties ?? {})).toEqual(['name']);
  });
});

describe('changedSections', () => {
  const base = {
    version: 2,
    name: 'Support bot',
    model: 'anthropic/claude-sonnet-5-5',
    instructions: 'Be helpful.',
  } as AgentSpecV2;

  it('returns [] for identical specs', () => {
    expect(changedSections(base, { ...base })).toEqual([]);
  });

  it('marks the section owning a changed key, in section order', () => {
    expect(changedSections(base, { ...base, model: 'openai/gpt-5' })).toEqual(['model']);
    expect(
      changedSections(base, { ...base, name: 'Bot 2', instructions: 'Be terse.' }),
    ).toEqual(['identity', 'instructions']);
  });

  it('ignores keys outside every section (version, flow, evals)', () => {
    expect(changedSections(base, { ...base, version: 2 })).toEqual([]);
  });
});

describe('sectionOf', () => {
  it('maps a top-level key path to its section', () => {
    expect(sectionOf('modelSettings.temperature')).toBe('model');
    expect(sectionOf('tools.0.builtin')).toBe('tools');
    expect(sectionOf('name')).toBe('identity');
  });

  it('returns undefined for hidden keys and unknown paths', () => {
    expect(sectionOf('flow.steps.0')).toBeUndefined();
    expect(sectionOf('evals.gate')).toBeUndefined();
    expect(sectionOf('version')).toBeUndefined();
    expect(sectionOf('nope.deep')).toBeUndefined();
  });
});
