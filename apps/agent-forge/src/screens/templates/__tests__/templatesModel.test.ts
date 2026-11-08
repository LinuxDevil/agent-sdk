import { describe, expect, it } from 'vitest';
import type { TemplateSummary } from '../../../../shared/wireTypes';
import { categoryCounts, requiresLine } from '../templatesModel';

const summary = (over: Partial<TemplateSummary>): TemplateSummary => ({
  id: 't',
  title: 'T',
  description: '',
  category: 'Cat',
  tags: [],
  requires: [],
  ...over,
});

describe('requiresLine', () => {
  it('is empty when nothing is required', () => {
    expect(requiresLine([])).toBe('');
  });

  it('names a single requirement', () => {
    expect(requiresLine(['provider_key'])).toBe('Needs a model API key.');
  });

  it('joins several Oxford-free, with "and" before the last', () => {
    expect(requiresLine(['provider_key', 'mcp', 'secret'])).toBe(
      'Needs a model API key, an MCP server and a secret.'
    );
    expect(requiresLine(['secret', 'model'])).toBe('Needs a secret and a specific model.');
  });
});

describe('categoryCounts', () => {
  it('puts All first with the total, then the categories sorted by name', () => {
    const items = [
      summary({ id: 'a', category: 'Support' }),
      summary({ id: 'b', category: 'Engineering' }),
      summary({ id: 'c', category: 'Support' }),
    ];
    expect(categoryCounts(items)).toEqual([
      { value: undefined, label: 'All', count: 3 },
      { value: 'Engineering', label: 'Engineering', count: 1 },
      { value: 'Support', label: 'Support', count: 2 },
    ]);
  });

  it('is just All for an empty list', () => {
    expect(categoryCounts([])).toEqual([{ value: undefined, label: 'All', count: 0 }]);
  });
});
