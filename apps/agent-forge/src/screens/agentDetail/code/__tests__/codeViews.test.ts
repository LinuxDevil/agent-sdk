import { describe, expect, it } from 'vitest';

import { buildTree, CODE_VIEW_LABELS, downloadName, parseCodeView } from '../codeViews';

describe('parseCodeView', () => {
  it('parses the three view names and defaults everything else to ts', () => {
    expect(parseCodeView('ts')).toBe('ts');
    expect(parseCodeView('yaml')).toBe('yaml');
    expect(parseCodeView('dir')).toBe('dir');
    expect(parseCodeView('x')).toBe('ts');
    expect(parseCodeView(null)).toBe('ts');
    expect(parseCodeView('')).toBe('ts');
  });

  it('has a label for every view', () => {
    expect(CODE_VIEW_LABELS).toEqual({ ts: 'TypeScript', yaml: 'YAML', dir: 'Agent directory' });
  });
});

describe('buildTree', () => {
  it('groups paths into folders first, then files, alphabetical case-insensitive', () => {
    const tree = buildTree([
      { path: 'tools/b.ts' },
      { path: 'agent.yaml' },
      { path: 'prompts/system.md' },
      { path: 'tools/A.ts' },
    ]);
    expect(tree.map((n) => n.name)).toEqual(['prompts', 'tools', 'agent.yaml']);
    expect(tree[0]).toMatchObject({ kind: 'dir', path: 'prompts' });
    expect(tree[1]).toMatchObject({ kind: 'dir', path: 'tools' });
    expect(tree[2]).toMatchObject({ kind: 'file', path: 'agent.yaml' });
    expect(tree[0].children?.map((n) => n.name)).toEqual(['system.md']);
    expect(tree[1].children?.map((n) => n.name)).toEqual(['A.ts', 'b.ts']);
  });

  it('nests deeper directories under their parents', () => {
    const tree = buildTree([{ path: 'skills/review/SKILL.md' }, { path: 'skills/review/check.md' }]);
    const skills = tree[0];
    expect(skills).toMatchObject({ name: 'skills', kind: 'dir', path: 'skills' });
    const review = skills.children?.[0];
    expect(review).toMatchObject({ name: 'review', kind: 'dir', path: 'skills/review' });
    expect(review?.children?.map((n) => n.name)).toEqual(['check.md', 'SKILL.md']);
  });

  it('returns an empty list for no files', () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe('downloadName', () => {
  it('names the TypeScript and YAML downloads from the agent id', () => {
    expect(downloadName('support-bot', 'ts')).toBe('support-bot.agent.ts');
    expect(downloadName('support-bot', 'yaml')).toBe('support-bot.yaml');
  });
});
