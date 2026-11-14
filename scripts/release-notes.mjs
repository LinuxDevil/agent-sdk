import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { changelogSection, hasReleasableChanges, renderNotes } from './releaseNotes.mjs';

const [mode, since = '', version = ''] = process.argv.slice(2);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const subjects = git('log', '--format=%s', since ? `${since}..HEAD` : 'HEAD').split('\n');

if (mode === 'check') {
  let norelease = [];
  if (since) {
    const date = git('log', '-1', '--format=%cs', since);
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--state', 'merged', '--base', 'main', '--label', 'norelease', '--search', `merged:>=${date}`, '--limit', '1000', '--json', 'number', '--jq', '.[].number'],
      { encoding: 'utf8' }
    );
    norelease = out.split('\n').filter(Boolean).map(Number);
  }
  console.log(hasReleasableChanges(subjects, norelease) ? 'true' : 'false');
} else if (mode === 'notes') {
  const repo = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY ?? 'LinuxDevil/lousho'}`;
  process.stdout.write(
    renderNotes({
      subjects,
      changelog: changelogSection(readFileSync('CHANGELOG.md', 'utf8'), version),
      compareUrl: since && version ? `${repo}/compare/${since}...v${version}` : '',
    })
  );
} else {
  console.error('usage: node scripts/release-notes.mjs check <last-tag> | notes <last-tag> <version>');
  process.exit(1);
}
