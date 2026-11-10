import { describe, it, expect } from 'vitest';
import { baseHarnessLayer, baseHarnessSchema } from './baseHarness';

const base = { schema: 'lousho.harness/1', constraints: [{ id: 'no-competitors', text: 'Never name a competitor.' }], runtime: { limits: { maxTurns: 10 } } };

describe('baseHarnessLayer', () => {
  it('no harness folder means no base layer', () => {
    expect(baseHarnessLayer({})).toBeUndefined();
    expect(baseHarnessLayer({ 'workspace.json': {}, 'shared/brand.md': 'x' })).toBeUndefined();
  });

  it('returns layer 0 for a harness document', () => {
    expect(baseHarnessLayer({ 'harness/harness.json': base, 'harness/voice.md': 'Be kind.' })).toEqual({ source: 'workspace base', harness: base });
  });

  it('parses a harness document given as text', () => {
    expect(baseHarnessLayer({ 'harness/harness.json': JSON.stringify(base) })?.harness).toEqual(base);
  });

  it('a harness folder without harness.json is an error', () => {
    expect(() => baseHarnessLayer({ 'harness/voice.md': 'Be kind.' })).toThrow('harness/harness.json');
  });

  it('text that is not JSON is an error', () => {
    expect(() => baseHarnessLayer({ 'harness/harness.json': '{' })).toThrow('harness/harness.json');
  });

  it('a document that is not an object is an error', () => {
    expect(() => baseHarnessLayer({ 'harness/harness.json': 'null' })).toThrow('harness/harness.json');
  });

  it('a base harness with extends is an error', () => {
    expect(() => baseHarnessLayer({ 'harness/harness.json': { ...base, extends: ['workspace:social-post'] } })).toThrow(/extends/);
  });

  it('a base harness with an id or version is an error', () => {
    expect(() => baseHarnessLayer({ 'harness/harness.json': { ...base, id: 'base' } })).toThrow(/'id'/);
    expect(() => baseHarnessLayer({ 'harness/harness.json': { ...base, version: '1.0.0' } })).toThrow(/'version'/);
  });

  it('a base harness with a forbidden key is an error naming R13', () => {
    expect(() => baseHarnessLayer({ 'harness/harness.json': { ...base, tools: [] } })).toThrow(/R13/);
  });
});

describe('baseHarnessSchema', () => {
  it('accepts a harness without id, version or extends', () => {
    expect(baseHarnessSchema.safeParse(base).success).toBe(true);
  });
});
