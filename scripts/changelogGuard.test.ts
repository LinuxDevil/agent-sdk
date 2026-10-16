import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs module without type declarations
import { missingChangelogHeading } from './changelogGuard.mjs';

describe('missingChangelogHeading', () => {
  const log = '# Changelog\n\n## [Unreleased]\n\n## [1.0.0-alpha.2] - 2026-01-01\n\n## [1.0.0-alpha.21] - 2026-01-02\n';

  it('accepts a version that has its own heading', () => {
    expect(missingChangelogHeading(log, '1.0.0-alpha.21')).toBeNull();
    expect(missingChangelogHeading('## [2.0.0]\n', '2.0.0')).toBeNull();
  });

  it('rejects a version with no heading, naming it', () => {
    expect(missingChangelogHeading(log, '1.0.0-alpha.23')).toMatch(/no "## \[1\.0\.0-alpha\.23\]" heading/);
  });

  it('does not match a version prefix or treat dots as wildcards', () => {
    expect(missingChangelogHeading(log, '1.0.0-alpha.')).not.toBeNull();
    expect(missingChangelogHeading('## [1x0x0]\n', '1.0.0')).not.toBeNull();
  });

  it('the checked-in CHANGELOG has a heading for the package version', () => {
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
    expect(missingChangelogHeading(readFileSync('CHANGELOG.md', 'utf8'), version)).toBeNull();
  });
});
