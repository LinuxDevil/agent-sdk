import { describe, expect, it } from 'vitest';
import { resolveFreshId, resolveNextCopyId, slugifyAgentId } from '../agentIds';

describe('slugifyAgentId', () => {
  it.each([
    ['Support triage', 'support-triage'],
    ['  Ops -- Bot  ', 'ops----bot'],
    ['already.fine_name-1', 'already.fine_name-1'],
    ['Ünïcode Nàme', 'n-code-n-me'],
    ['...', 'agent'],
    ['', 'agent'],
    ['   ', 'agent'],
  ])('slugifies %j to %j', (name, expected) => {
    expect(slugifyAgentId(name)).toBe(expected);
  });

  it('cuts to 64 chars', () => {
    const slug = slugifyAgentId('a'.repeat(100));
    expect(slug).toHaveLength(64);
  });

  it('trims leading and trailing -._', () => {
    expect(slugifyAgentId('..lead..')).toBe('lead');
    expect(slugifyAgentId('trail--')).toBe('trail');
  });
});

describe('resolveFreshId', () => {
  it('returns the base when free, then -2, -3, ...', async () => {
    const taken = new Set(['ops', 'ops-2']);
    const exists = (id: string) => taken.has(id);
    await expect(resolveFreshId('ops', exists)).resolves.toBe('ops-3');
    await expect(resolveFreshId('free', exists)).resolves.toBe('free');
  });

  it('supports an async exists predicate', async () => {
    await expect(resolveFreshId('ops', async (id) => id === 'ops')).resolves.toBe('ops-2');
  });

  it('throws when all 1000 candidates are taken', async () => {
    const exists = () => true;
    await expect(resolveFreshId('ops', exists)).rejects.toThrow(/taken/);
  });
});

describe('resolveNextCopyId', () => {
  it('returns <base>-copy, then -copy-2, -copy-3, ...', async () => {
    const taken = new Set(['ops-copy']);
    const exists = (id: string) => taken.has(id);
    await expect(resolveNextCopyId('ops', exists)).resolves.toBe('ops-copy-2');
    await expect(resolveNextCopyId('fresh', exists)).resolves.toBe('fresh-copy');
  });

  it('throws when all 1000 candidates are taken', async () => {
    await expect(resolveNextCopyId('ops', () => true)).rejects.toThrow(/taken/);
  });
});
