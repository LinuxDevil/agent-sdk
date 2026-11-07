import { describe, expect, it } from 'vitest';

import { changeView, collectionKey, formatChangeValue } from '../changeValue';

describe('formatChangeValue', () => {
  it('ellipsises strings past 120 chars with a single …', () => {
    const value = formatChangeValue('a'.repeat(130));
    expect(value).toHaveLength(121);
    expect(value?.endsWith('…')).toBe(true);
  });

  it('formats numbers, booleans and null', () => {
    expect(formatChangeValue(0.7)).toBe('0.7');
    expect(formatChangeValue(false)).toBe('false');
    expect(formatChangeValue(null)).toBeNull();
  });

  it('prefers id over name and falls back through the tag fields', () => {
    expect(formatChangeValue({ builtin: 'http' })).toBe('http');
    expect(formatChangeValue({ id: 'g1', name: 'pii' })).toBe('g1');
  });
});

describe('collectionKey', () => {
  it('keys items by the same tag precedence as formatChangeValue, then JSON', () => {
    expect(collectionKey('a')).toBe('a');
    expect(collectionKey({ id: 'g1', name: 'pii' })).toBe('g1');
    expect(collectionKey({ builtin: 'http' })).toBe('http');
    expect(collectionKey({ approval: 'always' })).toBe('{"approval":"always"}');
  });
});

describe('changeView', () => {
  it('matches collection items by tag and reports added, removed and edited keys', () => {
    expect(
      changeView({
        field: 'tools',
        label: 'Tools',
        op: 'edit',
        before: [{ builtin: 'http' }, { builtin: 'web-fetch' }],
        after: [{ builtin: 'http', approval: 'always' }, { builtin: 'current-date' }],
      }),
    ).toEqual({ kind: 'collection', added: ['current-date'], removed: ['web-fetch'], edited: ['http'] });
  });

  it('treats an undefined before side as an empty collection on add', () => {
    expect(changeView({ field: 'tools', label: 'Tools', op: 'add', after: ['a'] })).toEqual({
      kind: 'collection',
      added: ['a'],
      removed: [],
      edited: [],
    });
  });

  it('counts the added and removed lines of a text diff', () => {
    const lines = [
      { kind: 'same' as const, text: 'x' },
      { kind: 'removed' as const, text: 'a' },
      { kind: 'added' as const, text: 'b' },
      { kind: 'added' as const, text: 'c' },
    ];
    expect(changeView({ field: 'instructions', label: 'Instructions', op: 'edit', lines })).toEqual({
      kind: 'text',
      added: 2,
      removed: 1,
      lines,
    });
  });

  it('formats both sides of a scalar edit', () => {
    expect(
      changeView({
        field: 'model',
        label: 'Model',
        op: 'edit',
        before: 'anthropic/claude-haiku-5-5',
        after: 'anthropic/claude-sonnet-5-5',
      }),
    ).toEqual({ kind: 'scalar', before: 'anthropic/claude-haiku-5-5', after: 'anthropic/claude-sonnet-5-5' });
  });
});
