import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { specFilePath } from './files';

describe('specFilePath', () => {
  const base = path.join('some', 'agent');

  it('resolves a file reference inside the spec folder', () => {
    expect(specFilePath(base, 'instructions', 'a/b.md')).toBe(path.resolve(base, 'a/b.md'));
  });

  it('refuses a path that escapes the spec folder', () => {
    try {
      specFilePath(base, 'instructions', '../x');
      expect.unreachable('expected specFilePath to throw');
    } catch (error) {
      expect(error).toMatchObject({ code: 'LOUSHO_SPEC_INVALID', field: 'instructions' });
    }
  });
});
