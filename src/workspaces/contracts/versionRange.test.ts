import { describe, it, expect } from 'vitest';
import { isVersionRange } from './versionRange';

describe('isVersionRange', () => {
  it('accepts exact, caret and tilde ranges', () => {
    for (const range of ['1.2.3', '^1.2.3', '~0.4.0', '^0.0.1', '10.20.30', '1.0.0-beta.1', '^1', '^1.2', '~1', '~1.2', '^1.2.3-rc.1']) expect(isVersionRange(range)).toBe(true);
  });

  it('rejects everything else', () => {
    for (const range of ['', 'latest', '*', '1', '1.2', '^', '^1.', '^1.2.3.4', '^1.2.3+build', '1.2.3+build', '>=1.0.0', '1.x', '^^1.2.3', '~ 1.2.3', '01.2.3', ' 1.2.3', '1.2.3 ']) expect(isVersionRange(range)).toBe(false);
  });
});
