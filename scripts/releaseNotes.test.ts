import { describe, expect, it } from 'vitest';
import { changelogSection, hasReleasableChanges, parseCommit, renderNotes } from './releaseNotes.mjs';

describe('parseCommit', () => {
  it('reads type, scope, text and PR number from a squash-merge subject', () => {
    expect(parseCommit('feat(studio): AA19 author entry points (#1013)')).toEqual({
      type: 'feat',
      scope: 'studio',
      text: 'AA19 author entry points',
      pr: 1013,
    });
    expect(parseCommit('fix!: stop the loop (#7)')).toEqual({ type: 'fix', scope: null, text: 'stop the loop', pr: 7 });
  });

  it('puts unknown types and plain subjects under other, keeping the full text', () => {
    expect(parseCommit('chore(deps): bump vitest (#9)')).toEqual({
      type: 'other',
      scope: null,
      text: 'chore(deps): bump vitest',
      pr: 9,
    });
    expect(parseCommit('Merge things')).toEqual({ type: 'other', scope: null, text: 'Merge things', pr: null });
  });
});

describe('hasReleasableChanges', () => {
  it('is false when only release commits landed since the last tag', () => {
    expect(hasReleasableChanges(['chore(release): 1.0.0-alpha.117', ''], [])).toBe(false);
    expect(hasReleasableChanges([''], [])).toBe(false);
  });

  it('is false when every PR since the last tag is labelled norelease', () => {
    expect(hasReleasableChanges(['docs: readme (#1)', 'ci: tweak (#2)'], [1, 2, 3])).toBe(false);
  });

  it('is true when any PR lacks the label, or a commit has no PR number', () => {
    expect(hasReleasableChanges(['docs: readme (#1)', 'feat: thing (#2)'], [1])).toBe(true);
    expect(hasReleasableChanges(['docs: readme (#1)', 'hotfix on main'], [1])).toBe(true);
  });
});

describe('changelogSection', () => {
  const log =
    '# Changelog\n\n## [Unreleased]\n\n## [1.0.0-alpha.11] - 2026-11-16\n\n- Added A.\n\n## [1.0.0-alpha.1] - 2026-11-09\n\n- Added B.\n';

  it('returns the body under the exact version heading', () => {
    expect(changelogSection(log, '1.0.0-alpha.11')).toBe('- Added A.');
    expect(changelogSection(log, '1.0.0-alpha.1')).toBe('- Added B.');
  });

  it('returns an empty string for a missing version', () => {
    expect(changelogSection(log, '1.0.0-alpha.2')).toBe('');
  });
});

describe('renderNotes', () => {
  it('groups changes by type in feat, fix, docs, other order and skips release commits', () => {
    const notes = renderNotes({
      subjects: [
        'chore(release): 1.0.0-alpha.118',
        'docs(improve): record the proof (#1015)',
        'chore: bump deps (#1016)',
        'fix(cli): exit code (#1014)',
        'feat(studio): AA19 author entry points (#1013)',
      ],
      changelog: '- Added A.',
      compareUrl: 'https://github.com/o/r/compare/v1...v2',
    });
    expect(notes).toBe(
      [
        '- Added A.',
        '### Features\n\n- **studio:** AA19 author entry points (#1013)',
        '### Fixes\n\n- **cli:** exit code (#1014)',
        '### Docs\n\n- **improve:** record the proof (#1015)',
        '### Other\n\n- chore: bump deps (#1016)',
        '**Full Changelog**: https://github.com/o/r/compare/v1...v2',
      ].join('\n\n') + '\n'
    );
  });

  it('says so when nothing changed', () => {
    expect(renderNotes({ subjects: ['chore(release): 1.0.0-alpha.118'] })).toBe('No changes since the last release.\n');
  });
});
