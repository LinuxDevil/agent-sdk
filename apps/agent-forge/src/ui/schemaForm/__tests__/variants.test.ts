import { describe, expect, it } from 'vitest';

import { defaultForSchema, itemSummary, matchVariant, variantOptions } from '../variants';

import { SPEC, TOOL_REF, TRIGGER } from './fixture';

describe('variantOptions', () => {
  it('labels options by the required key no other option requires', () => {
    expect(variantOptions(SPEC, TOOL_REF).map((o) => o.label)).toEqual(['Builtin', 'Registry', 'File']);
    expect(variantOptions(SPEC, TOOL_REF).map((o) => o.index)).toEqual([0, 1, 2]);
  });

  it('labels options by a const on a shared discriminator key', () => {
    expect(variantOptions(SPEC, TRIGGER).map((o) => o.label)).toEqual(['Chat', 'Cron']);
  });

  it('prefers option.title and falls back to Option n', () => {
    const titled = { oneOf: [{ type: 'object', title: 'Web hook' }, { type: 'object' }] };
    expect(variantOptions(SPEC, titled).map((o) => o.label)).toEqual(['Web hook', 'Option 2']);
  });
});

describe('matchVariant', () => {
  const options = variantOptions(SPEC, TOOL_REF);

  it('returns the option the value validates cleanly against', () => {
    expect(matchVariant(SPEC, options, { registry: 'x' })).toBe(1);
    expect(matchVariant(SPEC, options, { builtin: 'http' })).toBe(0);
  });

  it('returns -1 when no option accepts the value', () => {
    expect(matchVariant(SPEC, options, { nope: 1 })).toBe(-1);
    expect(matchVariant(SPEC, options, undefined)).toBe(-1);
  });

  it('falls back to required-keys presence for half-filled values', () => {
    expect(matchVariant(SPEC, options, { builtin: '', id: 't1' })).toBe(0);
    expect(matchVariant(SPEC, options, { file: '', id: 't1' })).toBe(2);
  });
});

describe('defaultForSchema', () => {
  it('builds const discriminators and empty required scalars', () => {
    expect(defaultForSchema(SPEC, TRIGGER.oneOf![1])).toEqual({
      id: '',
      type: 'cron',
      cron: '',
      prompt: '',
    });
    expect(defaultForSchema(SPEC, TOOL_REF.anyOf![0])).toEqual({ builtin: '' });
  });

  it('returns scalar defaults for non-object schemas', () => {
    expect(defaultForSchema(SPEC, { type: 'string' })).toBe('');
    expect(defaultForSchema(SPEC, { type: 'object' })).toEqual({});
  });
});

describe('itemSummary', () => {
  it('prefers name/id/title, then the discriminating value, then Item n', () => {
    expect(itemSummary({ builtin: 'http' }, 0)).toBe('http');
    expect(itemSummary({ id: 'x', type: 'cron', cron: '0 * * * *' }, 4)).toBe('x');
    expect(itemSummary({ type: 'cron', cron: '0 * * * *' }, 4)).toBe('cron');
    expect(itemSummary({ name: 'Lint check' }, 1)).toBe('Lint check');
    expect(itemSummary({}, 2)).toBe('Item 3');
  });
});
