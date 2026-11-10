import { describe, it, expect } from 'vitest';
import { baseHarnessLayer, baseHarnessSchema, readBaseHarness } from './baseHarness';

const base = { schema: 'lousho.harness/1', constraints: [{ id: 'no-competitors', text: 'Never name a competitor.' }], runtime: { limits: { maxTurns: 10 } } };

describe('baseHarnessLayer', () => {
  it('no harness folder means no base layer', () => {
    expect(baseHarnessLayer({})).toBeUndefined();
    expect(baseHarnessLayer({ 'workspace.json': {}, 'shared/brand.md': 'x' })).toBeUndefined();
  });

  it('returns layer 0 for a harness document', () => {
    expect(baseHarnessLayer({ 'harness/harness.json': base, 'harness/voice.md': 'Be kind.' })).toEqual({ source: 'workspace base', harness: base, texts: {} });
  });

  it('parses a harness document given as text', () => {
    expect(baseHarnessLayer({ 'harness/harness.json': JSON.stringify(base) })?.harness).toEqual(base);
  });

  it('reads each listed instruction file into texts', () => {
    const harness = { ...base, instructions: ['voice.md', 'rules/format.md'] };
    const tree = { 'harness/harness.json': harness, 'harness/voice.md': 'Be kind.', 'harness/rules/format.md': 'Short.' };
    expect(baseHarnessLayer(tree)?.texts).toEqual({ 'voice.md': 'Be kind.', 'rules/format.md': 'Short.' });
  });

  it('a listed instruction file missing from the tree is a problem', () => {
    const result = readBaseHarness({ 'harness/harness.json': { ...base, instructions: ['voice.md'] } });
    expect(result.layer).toBeUndefined();
    expect(result.problems).toEqual([{ path: 'harness/voice.md', message: 'is listed in instructions but missing from the workspace' }]);
    expect(() => baseHarnessLayer({ 'harness/harness.json': { ...base, instructions: ['voice.md'] } })).toThrow('harness/voice.md');
  });

  it('uses the folder named by workspace.json, normalising ./ and a trailing slash', () => {
    const tree = { 'workspace.json': { harness: './rules/base/' }, 'rules/base/harness.json': base, 'harness/harness.json': { ...base, constraints: [] } };
    expect(baseHarnessLayer(tree)?.harness).toEqual(base);
    expect(baseHarnessLayer({ 'workspace.json': JSON.stringify({ harness: 'rules/base' }), 'rules/base/harness.json': base })?.harness).toEqual(base);
  });

  it('falls back to harness/ when workspace.json names no folder', () => {
    expect(baseHarnessLayer({ 'workspace.json': { name: 'x' }, 'harness/harness.json': base })?.harness).toEqual(base);
    expect(baseHarnessLayer({ 'workspace.json': [], 'harness/harness.json': base })?.harness).toEqual(base);
  });

  it('a workspace.json that is not JSON is a problem', () => {
    expect(readBaseHarness({ 'workspace.json': '{' }).problems).toEqual([{ path: 'workspace.json', message: 'is not valid JSON' }]);
  });

  it('a folder named by workspace.json with no files is a problem, not no layer', () => {
    const tree = { 'workspace.json': { harness: 'rules/base' }, 'harness/harness.json': base };
    expect(readBaseHarness(tree).problems).toEqual([{ path: 'rules/base', message: 'is named by workspace.json harness but has no files' }]);
    expect(() => baseHarnessLayer(tree)).toThrow('rules/base');
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

  it('a base harness with a forbidden key is an error naming R13, without a doubled prefix', () => {
    const problems = readBaseHarness({ 'harness/harness.json': { ...base, tools: [] } }).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toMatch(/^harness\.tools: .*\(R13\)$/);
    expect(() => baseHarnessLayer({ 'harness/harness.json': { ...base, tools: [] } })).toThrow(/^harness\/harness\.json: harness\.tools: .*R13/);
  });
});

describe('baseHarnessSchema', () => {
  it('accepts a harness without id, version or extends', () => {
    expect(baseHarnessSchema.safeParse(base).success).toBe(true);
  });
});
