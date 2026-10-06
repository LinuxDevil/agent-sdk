import { describe, it, expect } from 'vitest';
import { toolResultText } from './content';

describe('toolResultText', () => {
  it('unwraps a JSON-encoded string result', () => {
    expect(toolResultText({ role: 'tool', content: '"line one\\nline two"' })).toBe('line one\nline two');
    expect(toolResultText({ role: 'tool', content: '"plain"' })).toBe('plain');
  });

  it('keeps a non-string result as its JSON', () => {
    expect(toolResultText({ role: 'tool', content: '{"tier":"gold","revenue":1300}' })).toBe('{"tier":"gold","revenue":1300}');
    expect(toolResultText({ role: 'tool', content: 'null' })).toBe('null');
    expect(toolResultText({ role: 'tool', content: '42' })).toBe('42');
  });

  it('returns content that is not JSON unchanged', () => {
    expect(toolResultText({ role: 'tool', content: 'not json' })).toBe('not json');
    expect(toolResultText({ role: 'tool', content: '' })).toBe('');
  });

  it('reads content parts the way textOf does, then unwraps', () => {
    const content = [{ type: 'text' as const, text: '"hit' }, { type: 'text' as const, text: 's"' }];
    expect(toolResultText({ role: 'tool', content })).toBe('hits');
  });
});
