import { describe, it, expect } from 'vitest';
import { workspaceManifestSchema, type WorkspaceManifest } from './workspace';

const marketing: WorkspaceManifest = {
  schema: 'lousho.workspace/1',
  id: 'marketing',
  name: 'Marketing',
  version: '1.0.0',
  description: 'Plans, writes and publishes social content for the brand.',
  domain: 'marketing',
  mainAgent: { dir: './main-agent', inheritsShared: true },
  pages: ['content-research', 'instagram', 'facebook', 'tiktok'],
  agents: './agents',
  harnessProfiles: './harness-profiles',
  workflows: './workflows',
  dependencies: {
    agents: { 'global:copy-editor': '^1.2.0' },
    profiles: { 'global:social-post': '~2.0.0' },
  },
  defaults: {
    model: 'anthropic/claude-sonnet-5-5',
    limits: { maxConcurrentPages: 3, maxCostUsdPerRun: 2.5 },
  },
  budget: { mode: 'shared' },
  improve: { enabled: true, healer: 'per-page', proposerModel: 'openai/gpt-5' },
};

function issuesOf(value: unknown): { path: (string | number)[]; message: string }[] {
  const result = workspaceManifestSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: issue.path.map((segment) => (typeof segment === 'number' ? segment : String(segment))), message: issue.message }));
}

describe('workspaceManifestSchema', () => {
  it('accepts the Marketing manifest', () => {
    const result = workspaceManifestSchema.safeParse(marketing);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(marketing);
  });

  it('accepts mainAgent null with three pages', () => {
    const opsDesk = { schema: 'lousho.workspace/1', id: 'ops-desk', name: 'Ops desk', version: '0.1.0', description: 'Runs the operations pages directly.', mainAgent: null, pages: ['triage', 'billing', 'reports'] };
    expect(issuesOf(opsDesk)).toEqual([]);
  });

  it('accepts a base harness and a main-agent harness entry', () => {
    const withHarnesses = { ...marketing, harness: './harness/', mainAgent: { dir: './main-agent', harness: './main-agent/harness/' } };
    expect(issuesOf(withHarnesses)).toEqual([]);
  });

  it('rejects an unknown key with its path', () => {
    const issues = issuesOf({ ...marketing, improve: { enabled: true, autoApply: true } });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(['improve']);
    expect(issues[0].message).toContain('autoApply');
    expect(issuesOf({ ...marketing, work: 'x' })[0].path).toEqual([]);
    expect(issuesOf({ ...marketing, defaults: { limits: { maxPages: 2 } } })[0].path).toEqual(['defaults', 'limits']);
  });

  it('rejects an unlisted page folder name in pages', () => {
    expect(issuesOf({ ...marketing, pages: ['instagram', 'pages/tiktok'] })).toEqual([{ path: ['pages', 1], message: expect.stringContaining('page folder name') }]);
    expect(issuesOf({ ...marketing, pages: ['../outside'] })[0].path).toEqual(['pages', 0]);
    expect(issuesOf({ ...marketing, pages: ['Instagram Posts'] })[0].path).toEqual(['pages', 0]);
    expect(issuesOf({ ...marketing, pages: ['instagram', 'tiktok', 'instagram'] })).toEqual([{ path: ['pages', 2], message: "duplicate page 'instagram'" }]);
  });

  it('requires dependency keys to be global:<name> refs', () => {
    for (const key of ['copy-editor', 'workspace:copy-editor', 'local:copy-editor', 'global:copy-editor@^1.0.0', 'global:Copy_Editor', 'global:']) {
      const issues = issuesOf({ ...marketing, dependencies: { agents: { [key]: '^1.0.0' } } });
      expect(issues.length, key).toBeGreaterThan(0);
      expect(issues[0].path.slice(0, 2), key).toEqual(['dependencies', 'agents']);
    }
    expect(issuesOf({ ...marketing, dependencies: { profiles: { 'workspace:x': '1.0.0' } } }).length).toBeGreaterThan(0);
  });

  it('requires dependency values to be valid version ranges', () => {
    for (const range of ['', 'latest', '*', '>=1.0.0', '1.x', '1.2']) {
      expect(issuesOf({ ...marketing, dependencies: { agents: { 'global:copy-editor': range } } }), range).toEqual([
        { path: ['dependencies', 'agents', 'global:copy-editor'], message: expect.stringContaining('version range') },
      ]);
    }
    expect(issuesOf({ ...marketing, dependencies: { agents: { 'global:a': '1.2.3', 'global:b': '~1.2', 'global:c': '^1' } } })).toEqual([]);
  });

  it('rejects a non-semver version', () => {
    for (const version of ['1.0', 'v1.0.0', '1.0.0.0', '01.0.0', 'latest']) {
      expect(issuesOf({ ...marketing, version })).toEqual([{ path: ['version'], message: expect.stringContaining('semver') }]);
    }
    expect(issuesOf({ ...marketing, version: '2.1.0-beta.1+build.5' })).toEqual([]);
  });
});
