import { describe, expect, it } from 'vitest';
import { clampVersionText, VERSION_REQUEST_MAX_CHARS } from '../versionText';

describe('clampVersionText', () => {
  it('is null for null, undefined, empty and whitespace-only input', () => {
    expect(clampVersionText(null, 400)).toBeNull();
    expect(clampVersionText(undefined, 400)).toBeNull();
    expect(clampVersionText('', 400)).toBeNull();
    expect(clampVersionText('   \n\t  ', 400)).toBeNull();
  });

  it('collapses whitespace runs to one space and trims', () => {
    expect(clampVersionText('  build   me\n\ta   bot  ', 400)).toBe('build me a bot');
  });

  it('keeps text at exactly max chars untouched', () => {
    const text = 'x'.repeat(VERSION_REQUEST_MAX_CHARS);
    expect(clampVersionText(text, VERSION_REQUEST_MAX_CHARS)).toBe(text);
  });

  it('cuts to max chars ending in an ellipsis that counts toward max', () => {
    const text = clampVersionText('x'.repeat(VERSION_REQUEST_MAX_CHARS + 1), VERSION_REQUEST_MAX_CHARS);
    expect(text).toHaveLength(VERSION_REQUEST_MAX_CHARS);
    expect(text?.endsWith('…')).toBe(true);
    expect(text?.slice(0, -1)).toBe('x'.repeat(VERSION_REQUEST_MAX_CHARS - 1));
  });

  it('honours a smaller max', () => {
    expect(clampVersionText('abcdefghij', 5)).toBe('abcd…');
  });
});
