import { describe, it, expect } from 'vitest';
import { compareVersions, isVersionRange, satisfiesVersionRange } from './versionRange';

describe('isVersionRange', () => {
  it('accepts exact, caret and tilde ranges', () => {
    for (const range of ['1.2.3', '^1.2.3', '~0.4.0', '^0.0.1', '10.20.30', '1.0.0-beta.1', '^1', '^1.2', '~1', '~1.2', '^1.2.3-rc.1']) expect(isVersionRange(range)).toBe(true);
  });

  it('rejects everything else', () => {
    for (const range of ['', 'latest', '*', '1', '1.2', '^', '^1.', '^1.2.3.4', '^1.2.3+build', '1.2.3+build', '>=1.0.0', '1.x', '^^1.2.3', '~ 1.2.3', '01.2.3', ' 1.2.3', '1.2.3 ']) expect(isVersionRange(range)).toBe(false);
  });
});

describe('satisfiesVersionRange', () => {
  const table: [string, string, boolean][] = [
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['1.2.3-rc.1', '1.2.3-rc.1', true],
    ['1.2.3', '1.2.3-rc.1', false],
    ['1.0.0', '^1', true],
    ['1.9.9', '^1', true],
    ['2.0.0', '^1', false],
    ['0.9.0', '^1', false],
    ['1.5.0', '^1.2', true],
    ['1.1.0', '^1.2', false],
    ['1.2.3', '^1.2.3', true],
    ['1.2.2', '^1.2.3', false],
    ['0.0.0', '^0', true],
    ['0.9.9', '^0', true],
    ['1.0.0', '^0', false],
    ['0.0.5', '^0.0', true],
    ['0.1.0', '^0.0', false],
    ['0.2.9', '^0.2', true],
    ['0.3.0', '^0.2', false],
    ['0.2.5', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['1.0.0', '~1', true],
    ['1.2.0', '~1', true],
    ['2.0.0', '~1', false],
    ['1.2.9', '~1.2', true],
    ['1.3.0', '~1.2', false],
    ['1.2.5', '~1.2.3', true],
    ['1.2.2', '~1.2.3', false],
    ['1.3.0', '~1.2.3', false],
    ['1.5.0-beta', '^1', false],
    ['1.0.0-beta', '1.0.0', false],
    ['1.2.3-rc.2', '^1.2.3-rc.1', true],
    ['1.2.3-rc.0', '^1.2.3-rc.1', false],
    ['1.2.3-rc.10', '^1.2.3-rc.9', true],
    ['1.2.3-rc', '^1.2.3-rc.1', false],
    ['1.2.3-rc.1', '^1.2.3-alpha', true],
    ['1.2.3-1', '^1.2.3-alpha', false],
    ['1.2.3', '^1.2.3-rc.1', true],
    ['1.2.4-rc.1', '^1.2.3-rc.1', false],
    ['1.2.3', '>=1.0.0', false],
    ['1.2.3', '*', false],
    ['1.2.3', '', false],
    ['v1.2.3', '^1', false],
    ['1.2', '^1', false],
    ['01.2.3', '^1', false],
  ];

  it.each(table)('%s against %s is %s', (version, range, expected) => {
    expect(satisfiesVersionRange(version, range)).toBe(expected);
  });
});

describe('compareVersions', () => {
  it('orders by semver precedence, unparseable lowest', () => {
    const sorted = ['1.10.0', 'oops', '1.2.0', '1.2.0-rc.1', '1.2.0-alpha', '0.9.9', '2.0.0'].sort(compareVersions);
    expect(sorted).toEqual(['oops', '0.9.9', '1.2.0-alpha', '1.2.0-rc.1', '1.2.0', '1.10.0', '2.0.0']);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
});
