import { describe, it, expect } from 'vitest';
import { isVersionRange, satisfiesRange } from './versionRange';

describe('isVersionRange', () => {
  it('accepts exact, caret and tilde ranges', () => {
    for (const range of ['1.2.3', '^1.2.3', '~0.4.0', '^0.0.1', '10.20.30', '1.0.0-beta.1', '^1', '^1.2', '~1', '~1.2', '^1.2.3-rc.1']) expect(isVersionRange(range)).toBe(true);
  });

  it('rejects everything else', () => {
    for (const range of ['', 'latest', '*', '1', '1.2', '^', '^1.', '^1.2.3.4', '^1.2.3+build', '1.2.3+build', '>=1.0.0', '1.x', '^^1.2.3', '~ 1.2.3', '01.2.3', ' 1.2.3', '1.2.3 ']) expect(isVersionRange(range)).toBe(false);
  });
});

describe('satisfiesRange', () => {
  it.each([
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['1.9.0', '^1.2.3', true],
    ['1.2.2', '^1.2.3', false],
    ['2.0.0', '^1.2.3', false],
    ['0.2.5', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['1.4.0', '^1', true],
    ['2.0.0', '^1', false],
    ['0.2.9', '^0.2', true],
    ['0.3.0', '^0.2', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.9.9', '~1', true],
    ['2.0.0', '~1', false],
    ['1.2.5', '~1.2', true],
    ['1.3.0', '~1.2', false],
    ['1.3.0-beta.1', '^1.2.3', false],
    ['1.2.3-beta.2', '^1.2.3-beta.1', true],
    ['1.2.3-beta.0', '^1.2.3-beta.1', false],
    ['1.2.3', '^1.2.3-beta.1', true],
    ['1.2.3-beta.1', '1.2.3', false],
    ['1.2.3+build', '1.2.3', true],
    ['not-a-version', '^1.0.0', false],
    ['1.2.3', 'latest', false],
  ])('%s against %s is %s', (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });
});
