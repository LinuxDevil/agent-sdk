import { describe, expect, it } from 'vitest';
import { readFixtureTree, readNegativeIndex, readNegativeTree } from '../__fixtures__/readTree';
import { applyOps } from './authoringOps';
import type { WorkspaceTree } from './baseHarness';
import { validateWorkspace, type WorkspaceProblem } from './validate';

const errors = (problems: WorkspaceProblem[]): WorkspaceProblem[] => problems.filter((problem) => problem.severity === 'error');
const codes = (problems: WorkspaceProblem[]): string[] => [...new Set(problems.map((problem) => problem.code))];

function withFile(tree: WorkspaceTree, path: string, value: unknown): WorkspaceTree {
  return { ...tree, [path]: value };
}

function withoutFiles(tree: WorkspaceTree, prefix: string): WorkspaceTree {
  return Object.fromEntries(Object.entries(tree).filter(([path]) => !path.startsWith(prefix)));
}

function edit(tree: WorkspaceTree, path: string, change: (doc: Record<string, unknown>) => Record<string, unknown>): WorkspaceTree {
  return withFile(tree, path, change(structuredClone(tree[path]) as Record<string, unknown>));
}

const base = (): WorkspaceTree => readNegativeTree(readNegativeIndex().base);

describe('validateWorkspace', () => {
  it('Marketing and coding fixtures have 0 errors', () => {
    expect(validateWorkspace(readFixtureTree('marketing'), { mode: 'default' })).toEqual([]);
    expect(validateWorkspace(readFixtureTree('coding'), { mode: 'default' })).toEqual([]);
  });

  it('the no-main-agent fixture with three pages has 0 errors', () => {
    expect(validateWorkspace(readFixtureTree('ops-desk'), { mode: 'default' })).toEqual([]);
  });

  it('the negative base has 0 problems', () => {
    expect(validateWorkspace(base())).toEqual([]);
  });

  it('each negative fixture yields exactly its code', () => {
    const index = readNegativeIndex();
    expect(new Set(index.cases.map((item) => item.code)).size).toBe(22);
    for (const item of index.cases) {
      const problems = validateWorkspace(readNegativeTree(item.name), { mode: 'default' });
      expect(codes(problems), item.name).toEqual([item.code]);
      expect(errors(problems).map((problem) => problem.file), item.name).toContain(item.file);
    }
  });

  it('a rubric-only improvable page yields PRD017; with improve disabled it is a warning', () => {
    const tree = readNegativeTree('rubric-only-improvable');
    const improvable = validateWorkspace(tree);
    expect(improvable).toEqual([expect.objectContaining({ severity: 'error', code: 'PRD017', file: 'pages/main/harness/harness.json', path: 'evaluation.criteria' })]);
    expect(improvable[0].message).toContain('R19');
    const pageOff = edit(tree, 'pages/main/page.json', (doc) => ({ ...doc, improve: { enabled: false } }));
    expect(validateWorkspace(pageOff)).toEqual([expect.objectContaining({ severity: 'warning', code: 'PRD017' })]);
    const workspaceOff = edit(tree, 'workspace.json', (doc) => ({ ...doc, improve: { enabled: false } }));
    expect(validateWorkspace(workspaceOff)).toEqual([expect.objectContaining({ severity: 'warning', code: 'PRD017' })]);
    const pageOn = edit(workspaceOff, 'pages/main/page.json', (doc) => ({ ...doc, improve: { enabled: true } }));
    expect(validateWorkspace(pageOn)).toEqual([expect.objectContaining({ severity: 'error', code: 'PRD017' })]);
  });

  it('validation is pure: same tree, same problems in the same order', () => {
    const tree = readNegativeTree('workflow-unknown-alias');
    const snapshot = structuredClone(tree);
    const first = validateWorkspace(tree);
    expect(validateWorkspace(tree)).toEqual(first);
    expect(tree).toEqual(snapshot);
    const marketing = readFixtureTree('marketing');
    const broken = withFile(withFile(marketing, 'pages/facebook-videos/policy.json', { tools: { allow: ['*'] } }), 'workspace.json', { ...(marketing['workspace.json'] as object), pages: ['ghost', 'instagram-videos', 'facebook-videos', 'content-research'] });
    expect(validateWorkspace(broken)).toEqual(validateWorkspace(structuredClone(broken)));
  });

  it('strict mode only reports that v1 has no lock, as information', () => {
    const problems = validateWorkspace(readFixtureTree('marketing'), { mode: 'strict' });
    expect(problems).toEqual([expect.objectContaining({ severity: 'info', code: 'PRD029', file: 'workspace.lock.json' })]);
  });

  it('never throws: garbage input becomes problems', () => {
    expect(codes(validateWorkspace({}))).toEqual(['PRD023']);
    expect(codes(validateWorkspace({ 'workspace.json': '{not json' }))).toEqual(['PRD028']);
    expect(codes(validateWorkspace({ 'workspace.json': [] }))).toEqual(['PRD023']);
    const tree = withFile(withFile(base(), 'pages/main/page.json', 'oops'), 'pages/main/agents.json', 42);
    expect(() => validateWorkspace(tree)).not.toThrow();
    expect(errors(validateWorkspace(tree)).length).toBeGreaterThan(0);
  });

  it('JSON files given as text are parsed like objects', () => {
    const tree = Object.fromEntries(Object.entries(readFixtureTree('marketing')).map(([path, value]) => [path, typeof value === 'string' ? value : JSON.stringify(value)]));
    expect(validateWorkspace(tree)).toEqual([]);
  });
});

describe('policy lives only in shared/policies (R13, G6)', () => {
  it('a policy file with an invalid field names R13 and G6', () => {
    const tree = edit(base(), 'shared/policies/policy.json', (doc) => ({ ...doc, network: { allowHosts: ['HTTP://x'] } }));
    const problems = validateWorkspace(tree);
    expect(codes(problems)).toEqual(['PRD026']);
    expect(problems[0]).toMatchObject({ file: 'shared/policies/policy.json', path: 'network.allowHosts.0' });
    expect(problems[0].message).toMatch(/R13.*G6/);
  });

  it('any other file under shared/policies is refused', () => {
    const problems = validateWorkspace(withFile(base(), 'shared/policies/extra.json', { tools: { allow: ['bash'] } }));
    expect(problems).toEqual([expect.objectContaining({ code: 'PRD014', file: 'shared/policies/extra.json' })]);
    expect(problems[0].message).toContain('G6');
  });

  it('policy keys in goal or workflow files are refused, nested ones too', () => {
    const tree = withFile(base(), 'notes/settings.json', { nested: { secrets: [] } });
    expect(validateWorkspace(tree)).toEqual([expect.objectContaining({ code: 'PRD014', file: 'notes/settings.json', path: 'nested.secrets' })]);
  });

  it('agent files may declare their own tools', () => {
    const tree = edit(base(), 'agents/helper/agent.json', (doc) => ({ ...doc, tools: ['read_file'] }));
    expect(validateWorkspace(tree)).toEqual([]);
  });

  it('workspace folder fields may not point into shared/policies, pages or each other', () => {
    for (const [field, value] of [['agents', './shared/policies'], ['workflows', 'pages/flows'], ['harnessProfiles', './harness/profiles']] as const) {
      const tree = edit(base(), 'workspace.json', (doc) => ({ ...doc, [field]: value }));
      const problems = validateWorkspace(tree);
      expect(problems, field).toContainEqual(expect.objectContaining({ code: 'PRD027', file: 'workspace.json', path: field }));
      expect(codes(problems), field).toEqual(['PRD027']);
    }
    const twin = edit(base(), 'workspace.json', (doc) => ({ ...doc, agents: 'stuff', workflows: './stuff/' }));
    expect(validateWorkspace(twin)).toEqual([expect.objectContaining({ code: 'PRD027', path: 'workflows' })]);
  });
});

describe('cross-file checks', () => {
  it('a file inside a nested pages folder is refused', () => {
    expect(codes(validateWorkspace(withFile(base(), 'pages/main/pages/inner/page.json', {})))).toEqual(['PRD009']);
  });

  it('leftover main-agent files are refused when mainAgent is null', () => {
    const problems = validateWorkspace(withFile(base(), 'main-agent/instructions.md', 'Route.'));
    expect(problems).toEqual([expect.objectContaining({ code: 'PRD011', file: 'main-agent/instructions.md' })]);
  });

  it('a main harness above the workspace concurrency limit is a warning', () => {
    const marketing = readFixtureTree('marketing');
    const tree = edit(marketing, 'main-agent/harness/main-harness.json', (doc) => ({ ...doc, limits: { maxConcurrentPages: 9 } }));
    expect(validateWorkspace(tree)).toEqual([expect.objectContaining({ severity: 'warning', code: 'PRD031' })]);
  });

  it('a main harness that lists a missing prose file is refused', () => {
    const tree = withoutFiles(readFixtureTree('marketing'), 'main-agent/harness/routing.md');
    expect(validateWorkspace(tree)).toEqual([expect.objectContaining({ code: 'PRD011', file: 'main-agent/harness/routing.md' })]);
  });

  it('every extends profile exists, or is a global ref resolveGlobal answers', () => {
    const tree = edit(base(), 'pages/main/page.json', (doc) => ({ ...doc, harness: { extends: ['global:tones/calm@^1.0.0'] } }));
    expect(validateWorkspace(tree)).toEqual([expect.objectContaining({ code: 'PRD024', file: 'pages/main/page.json', path: 'harness.extends.0' })]);
    const profile = { 'harness.json': { schema: 'lousho.harness/1', id: 'calm', version: '1.0.0', instructions: ['calm.md'] }, 'calm.md': 'Stay calm.' };
    const resolveGlobal = (ref: string): WorkspaceTree | undefined => (ref === 'global:tones/calm@^1.0.0' ? profile : undefined);
    expect(validateWorkspace(tree, { mode: 'default', resolveGlobal })).toEqual([]);
    const missing = edit(base(), 'pages/main/page.json', (doc) => ({ ...doc, harness: { extends: ['workspace:ghost', 'nope'] } }));
    expect(validateWorkspace(missing).map((problem) => problem.code)).toEqual(['PRD024', 'PRD024']);
  });

  it('a global profile that fails its schema is reported against its ref', () => {
    const tree = edit(base(), 'pages/main/page.json', (doc) => ({ ...doc, harness: { extends: ['global:tones/calm@^1.0.0'] } }));
    const resolveGlobal = (): WorkspaceTree => ({ 'harness.json': { schema: 'lousho.harness/1', version: '1.0.0' } });
    expect(validateWorkspace(tree, { resolveGlobal })).toEqual([expect.objectContaining({ code: 'PRD003', file: 'global:tones/calm@^1.0.0' })]);
  });

  it('files a harness lists must exist', () => {
    const tree = withoutFiles(base(), 'pages/main/harness/');
    const withHarness = withFile(tree, 'pages/main/harness/harness.json', base()['pages/main/harness/harness.json']);
    expect(codes(validateWorkspace(withHarness))).toEqual(['PRD032']);
    expect(validateWorkspace(withHarness).map((problem) => problem.file)).toEqual(['pages/main/harness/task.md', 'pages/main/harness/checks/report-present.ts']);
  });

  it('capabilities.require is covered by the attached agents', () => {
    const requiring = edit(base(), 'pages/main/harness/harness.json', (doc) => ({ ...doc, capabilities: { require: ['image.generate'] } }));
    expect(validateWorkspace(requiring)).toEqual([expect.objectContaining({ code: 'PRD025', path: 'capabilities.require.0' })]);
    const covered = edit(requiring, 'agents/helper/agent.json', (doc) => ({ ...doc, capabilities: ['image'] }));
    expect(validateWorkspace(covered)).toEqual([]);
    const globalAgent = edit(requiring, 'pages/main/agents.json', (doc) => ({ ...doc, agents: [...(doc.agents as unknown[]), { as: 'checker', ref: 'global:fact-checker@^1.0.0' }] }));
    expect(validateWorkspace(globalAgent)).toEqual([]);
  });

  it('goal and workflow files a page names must exist and be well formed', () => {
    const goal = withoutFiles(readNegativeTree('goal-check-missing-criterion'), 'pages/main/goal.json');
    expect(validateWorkspace(goal)).toEqual([expect.objectContaining({ code: 'PRD030', file: 'pages/main/goal.json' })]);
    const flow = withFile(readNegativeTree('workflow-unknown-alias'), 'pages/main/workflow.json', { code: 'x', name: 'X', flow: { type: 'mystery', id: 'a' } });
    expect(codes(validateWorkspace(flow))).toEqual(['PRD030']);
    const shared = edit(base(), 'pages/main/page.json', (doc) => ({ ...doc, execution: { type: 'workflow', workflow: { workflow: 'workspace:ghost' } } }));
    expect(validateWorkspace(shared)).toEqual([expect.objectContaining({ code: 'PRD030', file: 'workflows/ghost/workflow.json' })]);
  });

  it('a base harness forbidden key is an R13 problem in the base harness file', () => {
    const tree = withFile(base(), 'harness/harness.json', { schema: 'lousho.harness/1', tools: ['bash'] });
    expect(validateWorkspace(tree)).toEqual([expect.objectContaining({ code: 'PRD001', file: 'harness/harness.json' })]);
  });

  it('UI bindings resolve a harness schema given as a relative path', () => {
    const tree = base();
    const harness = tree['pages/main/harness/harness.json'] as { inputs: { schema: unknown } };
    const byPath = withFile(edit(tree, 'pages/main/harness/harness.json', (doc) => ({ ...doc, inputs: { schema: 'schemas/input.json' } })), 'pages/main/schemas/input.json', harness.inputs.schema);
    expect(validateWorkspace(byPath)).toEqual([]);
    const renamed = withFile(byPath, 'pages/main/schemas/input.json', { type: 'object', properties: { topic: { type: 'string' } } });
    expect(codes(validateWorkspace(renamed))).toEqual(['PRD012']);
  });

  it('local refs need a folder under the page', () => {
    const tree = edit(base(), 'pages/main/agents.json', (doc) => ({ ...doc, agents: [{ as: 'helper', ref: 'local:helper' }] }));
    expect(validateWorkspace(tree)).toEqual([expect.objectContaining({ code: 'PRD020', file: 'pages/main/agents.json', path: 'agents.0.ref' })]);
  });
});

describe('applyOps with validateWorkspace', () => {
  it("refuses removing a page's only executable criterion", () => {
    const result = applyOps(base(), [{ op: 'remove_criterion', target: { kind: 'page', page: 'main' }, id: 'report-present' }], { validate: validateWorkspace });
    expect(result.tree).toEqual(base());
    expect(result.problems).toContainEqual(expect.objectContaining({ opIndex: 0, path: 'pages/main/harness/harness.json', code: 'PRD017' }));
  });

  it('refuses detaching an alias a workflow still uses', () => {
    const marketing = readFixtureTree('marketing');
    const result = applyOps(marketing, [{ op: 'detach_agent', page: 'instagram-videos', as: 'voice' }], { validate: validateWorkspace });
    expect(result.tree).toBe(marketing);
    expect(result.problems).toContainEqual(expect.objectContaining({ code: 'PRD019', path: 'workflows/video-production/workflow.json' }));
  });

  it('a warning does not refuse a batch', () => {
    const tree = edit(readNegativeTree('rubric-only-improvable'), 'workspace.json', (doc) => ({ ...doc, improve: { enabled: false } }));
    const result = applyOps(tree, [{ op: 'set_workspace_field', field: 'name', value: 'Renamed' }], { validate: validateWorkspace });
    expect(result.problems).toEqual([]);
  });
});
