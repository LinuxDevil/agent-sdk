import { describe, it, expect } from 'vitest';
import type { AgentSpecV2 } from 'lousho';
import { sortKeysDeep } from '../../../shared/stableJson';
import { specHash } from '../specHash';

const base: AgentSpecV2 = { version: 2, name: 'bot', model: 'mock/m1', instructions: 'Be helpful.' };

describe('sortKeysDeep', () => {
  it('sorts object keys at every depth', () => {
    const sorted = sortKeysDeep({ b: { d: 1, c: 2 }, a: { f: { h: 1, g: 2 } } }) as Record<string, unknown>;
    expect(Object.keys(sorted)).toEqual(['a', 'b']);
    expect(Object.keys(sorted.b as object)).toEqual(['c', 'd']);
    expect(Object.keys((sorted.a as { f: object }).f)).toEqual(['g', 'h']);
  });

  it('keeps array order and sorts objects inside arrays', () => {
    const sorted = sortKeysDeep({ list: [{ b: 1, a: 2 }, { d: 3, c: 4 }] }) as { list: object[] };
    expect(Object.keys(sorted.list[0])).toEqual(['a', 'b']);
    expect(Object.keys(sorted.list[1])).toEqual(['c', 'd']);
  });

  it('passes scalars and null through unchanged', () => {
    expect(sortKeysDeep('x')).toBe('x');
    expect(sortKeysDeep(7)).toBe(7);
    expect(sortKeysDeep(null)).toBe(null);
    expect(sortKeysDeep(undefined)).toBeUndefined();
  });
});

describe('specHash', () => {
  it('is identical for two specs that differ only in key order', () => {
    const a: AgentSpecV2 = { version: 2, name: 'bot', model: 'mock/m1', instructions: 'Be helpful.', description: 'd' };
    const b = { instructions: 'Be helpful.', description: 'd', model: 'mock/m1', name: 'bot', version: 2 } as AgentSpecV2;
    expect(specHash(a)).toBe(specHash(b));
  });

  it('differs when an array order differs (order is meaningful there)', () => {
    const a = {
      ...base,
      guardrails: [
        { id: 'g1', name: 'pii' },
        { id: 'g2', name: 'regex', options: { pattern: 'x' } },
      ],
    } as unknown as AgentSpecV2;
    const b = {
      ...base,
      guardrails: [
        { id: 'g2', name: 'regex', options: { pattern: 'x' } },
        { id: 'g1', name: 'pii' },
      ],
    } as unknown as AgentSpecV2;
    expect(specHash(a)).not.toBe(specHash(b));
  });

  it("is a 'sha256:' prefix plus 64 hex chars (71 total)", () => {
    const hash = specHash(base);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hash).toHaveLength(71);
  });
});
