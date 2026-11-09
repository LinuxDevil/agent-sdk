const GROUPS = [
  { type: 'feat', title: 'Features' },
  { type: 'fix', title: 'Fixes' },
  { type: 'docs', title: 'Docs' },
  { type: 'other', title: 'Other' },
];

const RELEASE_COMMIT = /^chore\(release\):/;

export function parseCommit(subject) {
  const pr = subject.match(/\s\(#(\d+)\)$/);
  const rest = pr ? subject.slice(0, pr.index) : subject;
  const cc = rest.match(/^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/);
  const known = cc && GROUPS.some((g) => g.type === cc[1].toLowerCase()) ? cc[1].toLowerCase() : 'other';
  return {
    type: known,
    scope: cc && known !== 'other' ? cc[2] || null : null,
    text: cc && known !== 'other' ? cc[3] : rest,
    pr: pr ? Number(pr[1]) : null,
  };
}

export function changesSince(subjects) {
  return subjects.filter((s) => s.trim() && !RELEASE_COMMIT.test(s));
}

export function hasReleasableChanges(subjects, noreleasePrs) {
  const skip = new Set(noreleasePrs);
  return changesSince(subjects).some((s) => {
    const { pr } = parseCommit(s);
    return pr === null || !skip.has(pr);
  });
}

export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
}

export function renderNotes({ subjects, changelog = '', compareUrl = '' }) {
  const parsed = changesSince(subjects).map(parseCommit);
  const parts = [];
  if (changelog) parts.push(changelog);
  for (const g of GROUPS) {
    const items = parsed.filter((c) => c.type === g.type);
    if (!items.length) continue;
    const lines = items.map(
      (c) => `- ${c.scope ? `**${c.scope}:** ` : ''}${c.text}${c.pr === null ? '' : ` (#${c.pr})`}`
    );
    parts.push(`### ${g.title}\n\n${lines.join('\n')}`);
  }
  if (!parsed.length) parts.push('No changes since the last release.');
  if (compareUrl) parts.push(`**Full Changelog**: ${compareUrl}`);
  return parts.join('\n\n') + '\n';
}
