import { describe, it, expect } from 'vitest';
import { pageSchema, findNestedPages, WORK_TYPES, type PageManifest } from './page';

const base = {
  schema: 'lousho.page/1',
  id: 'instagram',
  name: 'Instagram',
  description: 'Plans and writes Instagram posts for the brand.',
  harness: { extends: ['global:social-post'], overrides: './harness/' },
  agents: './agents.json',
} as const;

const fixtures: Record<string, PageManifest> = {
  single: { ...base, harness: { ...base.harness, extends: [...base.harness.extends] }, execution: { type: 'single', single: { agent: 'writer' } } },
  'multi-agent': { ...base, harness: { ...base.harness, extends: [...base.harness.extends] }, execution: { type: 'multi-agent', multiAgent: { lead: 'editor', delegates: ['writer', 'designer'] } } },
  workflow: { ...base, harness: { ...base.harness, extends: [...base.harness.extends] }, execution: { type: 'workflow', workflow: { workflow: './workflow.json' } } },
  'goal-oriented': { ...base, harness: { ...base.harness, extends: [...base.harness.extends] }, execution: { type: 'goal-oriented', goal: { lead: 'editor', delegates: ['writer'], goal: './goal.json' } } },
};

function issuesOf(value: unknown): { path: (string | number)[]; message: string }[] {
  const result = pageSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: issue.path.map((segment) => (typeof segment === 'number' ? segment : String(segment))), message: issue.message }));
}

describe('pageSchema', () => {
  it('lists the four work types', () => {
    expect(WORK_TYPES).toEqual(['single', 'multi-agent', 'workflow', 'goal-oriented']);
  });

  for (const [type, fixture] of Object.entries(fixtures)) {
    it(`accepts a valid ${type} page`, () => {
      const result = pageSchema.safeParse(fixture);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual(fixture);
    });
  }

  it('accepts a full page with every optional field', () => {
    const full: PageManifest = {
      ...fixtures.single,
      domain: 'marketing',
      execution: { type: 'single', single: { agent: 'writer' }, limits: { maxDurationMs: 300000, maxTurns: 20, maxCostUsd: 1.5 }, onFailure: 'ask', checkpoint: true },
      improve: { enabled: false },
      platform: { profile: 'social', adapter: 'instagram' },
      ui: './ui/page.ui.json',
      defaults: { model: 'anthropic/claude-sonnet-5-5' },
      runtime: { kind: 'local' },
    };
    expect(issuesOf(full)).toEqual([]);
  });

  it('the active type must have its config block', () => {
    const blocks = { single: 'single', 'multi-agent': 'multiAgent', workflow: 'workflow', 'goal-oriented': 'goal' };
    for (const type of WORK_TYPES) {
      const issues = issuesOf({ ...base, execution: { type } });
      expect(issues).toHaveLength(1);
      expect(issues[0].path).toEqual(['execution', blocks[type]]);
      expect(issues[0].message).toContain(`'${type}'`);
    }
  });

  it('inactive workflow and goal blocks are kept and validated', () => {
    const execution = { type: 'single', single: { agent: 'writer' }, workflow: { workflow: 'workspace:publish-flow' }, goal: { lead: 'editor', goal: './goal.json' } };
    const page = { ...base, execution };
    const result = pageSchema.safeParse(page);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(page);
    expect(issuesOf({ ...page, execution: { ...execution, workflow: { workflow: './other.json' } } })[0].path).toEqual(['execution', 'workflow', 'workflow']);
    expect(issuesOf({ ...page, execution: { ...execution, goal: { goal: './goal.json' } } })[0].path).toEqual(['execution', 'goal', 'lead']);
  });

  it('goal-oriented accepts lead and delegates', () => {
    expect(issuesOf(fixtures['goal-oriented'])).toEqual([]);
    expect(issuesOf({ ...base, execution: { type: 'goal-oriented', goal: { lead: 'editor', delegates: [], goal: './goal.json' } } })).toEqual([]);
  });

  it('multi-agent without lead is an error', () => {
    const issues = issuesOf({ ...base, execution: { type: 'multi-agent', multiAgent: { delegates: ['writer'] } } });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(['execution', 'multiAgent', 'lead']);
  });

  it('execution names an agent alias, not a ref', () => {
    for (const agent of ['workspace:writer', 'local:writer', 'global:writer']) {
      const issues = issuesOf({ ...base, execution: { type: 'single', single: { agent } } });
      expect(issues).toHaveLength(1);
      expect(issues[0].path).toEqual(['execution', 'single', 'agent']);
      expect(issues[0].message).toContain('alias');
    }
    expect(issuesOf({ ...base, execution: { type: 'multi-agent', multiAgent: { lead: 'editor', delegates: ['global:writer'] } } })[0].path).toEqual(['execution', 'multiAgent', 'delegates', 0]);
    expect(issuesOf({ ...base, execution: { type: 'goal-oriented', goal: { lead: 'local:editor', goal: './goal.json' } } })[0].path).toEqual(['execution', 'goal', 'lead']);
  });

  it('runtime.kind remote is rejected as reserved', () => {
    const issues = issuesOf({ ...fixtures.single, runtime: { kind: 'remote' } });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(['runtime', 'kind']);
    expect(issues[0].message).toContain('reserved');
  });

  it('rejects an unknown key, an unsafe path, a missing description and a bad onFailure', () => {
    expect(issuesOf({ ...fixtures.single, work: 'x' })[0].path).toEqual([]);
    expect(issuesOf({ ...fixtures.single, ui: '../ui.json' })[0].path).toEqual(['ui']);
    expect(issuesOf({ ...fixtures.single, description: undefined })[0].path).toEqual(['description']);
    expect(issuesOf({ ...fixtures.single, execution: { type: 'single', single: { agent: 'writer' }, onFailure: 'retry' } })[0].path).toEqual(['execution', 'onFailure']);
  });

  it('rejects invalid limits and allows pages deeper in a path', () => {
    const limited = (limits: unknown) => issuesOf({ ...fixtures.single, execution: { type: 'single', single: { agent: 'writer' }, limits } });
    expect(limited({ maxSteps: 3 })[0].path).toEqual(['execution', 'limits']);
    expect(limited({ maxTurns: 1.5 })[0].path).toEqual(['execution', 'limits', 'maxTurns']);
    expect(limited({ maxDurationMs: 0 })[0].path).toEqual(['execution', 'limits', 'maxDurationMs']);
    expect(issuesOf({ ...fixtures.single, ui: './ui/pages/main.json' })).toEqual([]);
  });

  it('accepts a page without agents', () => {
    const { agents: _agents, ...withoutAgents } = fixtures.single;
    expect(issuesOf(withoutAgents)).toEqual([]);
  });

  it('rejects nested pages in a path field', () => {
    expect(issuesOf({ ...fixtures.single, agents: './pages/inner/agents.json' })).toEqual([{ path: ['agents'], message: 'nested pages are not supported in v1' }]);
  });
});

describe('findNestedPages', () => {
  it('flags only paths whose first segment is pages', () => {
    expect(findNestedPages(['page.json', 'agents.json', 'harness/rules.md', 'pages/x/page.json', './pages/y/page.json', 'ui/pages/x.json', 'resources/pages/landing.md', './ui/pages/main.json'])).toEqual(['pages/x/page.json', './pages/y/page.json']);
    expect(findNestedPages(['page.json', 'pages.md'])).toEqual([]);
  });
});
