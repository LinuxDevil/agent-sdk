import { describe, it, expect } from 'vitest';
import { attachmentsSchema } from './agentRefs';
import { AUTHORING_OP_NAMES, applyOps, authoringOpJsonSchema, authoringOpSchema, opFiles, type AuthoringOp } from './authoringOps';
import { MARKETING_BUILD_OPS } from './__fixtures__/authoringOps';
import type { WorkspaceTree } from './baseHarness';
import { harnessSchema } from './harness';
import { mainHarnessSchema } from './mainHarness';
import { pageSchema } from './page';
import { validateWorkspace } from './validate';
import { workspaceManifestSchema } from './workspace';

const apply = (tree: WorkspaceTree, ops: readonly unknown[]) => applyOps(tree, ops, { validate: () => [] });

function build(): WorkspaceTree {
  const result = apply({}, MARKETING_BUILD_OPS);
  expect(result.problems).toEqual([]);
  return result.tree;
}

function changedPaths(before: WorkspaceTree, after: WorkspaceTree): string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((path) => JSON.stringify(before[path]) !== JSON.stringify(after[path]));
}

const EXTRA_OPS: AuthoringOp[] = [
  { op: 'set_workspace_field', field: 'description', value: 'Social video work.' },
  { op: 'set_page_field', page: 'instagram-videos', field: 'domain', value: 'marketing' },
  { op: 'remove_extends', page: 'instagram-videos', ref: 'workspace:platforms/instagram' },
  { op: 'remove_criterion', target: { kind: 'page', page: 'facebook-videos' }, id: 'script-present' },
  { op: 'add_criterion', target: { kind: 'base' }, criterion: { id: 'on-brand', description: 'Matches the brand voice.', rubric: 'Reads like the brand.' } },
  { op: 'write_agent_prose', agent: 'script-maker', text: 'Write short scripts.' },
  { op: 'create_agent', name: 'hook-writer', page: 'facebook-videos', description: 'Writes hooks.', instructions: 'Open with a question.' },
  { op: 'set_attachment_field', page: 'facebook-videos', as: 'voice', field: 'role', value: 'Reads the script aloud.' },
  { op: 'detach_agent', page: 'facebook-videos', as: 'voice' },
  { op: 'set_execution_config', page: 'facebook-videos', key: 'limits', value: { maxTurns: 6 } },
  { op: 'set_execution_config', page: 'facebook-videos', key: 'single', value: { agent: 'script' } },
  { op: 'set_execution_type', page: 'facebook-videos', type: 'single' },
  { op: 'write_goal', page: 'facebook-videos', goal: { schema: 'lousho.goal/1', goal: 'Reach ten likes.' } },
  { op: 'reset_page_ui', page: 'instagram-videos' },
  { op: 'remove_page', page: 'facebook-videos' },
];

describe('authoring operations', () => {
  it('each op changes only the files opFiles lists', () => {
    let tree: WorkspaceTree = {};
    for (const operation of MARKETING_BUILD_OPS) {
      const listed = opFiles(operation, tree);
      const result = apply(tree, [operation]);
      expect(result.problems).toEqual([]);
      expect(listed.length).toBeGreaterThan(0);
      expect(changedPaths(tree, result.tree).filter((path) => !listed.includes(path))).toEqual([]);
      tree = result.tree;
    }
    for (const operation of EXTRA_OPS) {
      const listed = opFiles(operation, tree);
      const result = apply(tree, [operation]);
      expect(result.problems, operation.op).toEqual([]);
      expect(changedPaths(tree, result.tree).filter((path) => !listed.includes(path)), operation.op).toEqual([]);
      expect(changedPaths(tree, result.tree).length, operation.op).toBeGreaterThan(0);
      tree = result.tree;
    }
  });

  it('applyOps on the Marketing fixture builds the fixture from blank', () => {
    const tree = build();
    expect(Object.keys(tree).sort()).toEqual([
      'agents/script-maker/agent.json',
      'agents/script-maker/instructions.md',
      'agents/video-maker/agent.json',
      'agents/video-maker/instructions.md',
      'agents/voice-maker/agent.json',
      'agents/voice-maker/instructions.md',
      'harness/brand-voice.md',
      'harness/harness.json',
      'main-agent/agent.json',
      'main-agent/harness/main-harness.json',
      'main-agent/harness/routing.md',
      'main-agent/instructions.md',
      'pages/content-research/agents.json',
      'pages/content-research/agents/research-lead/agent.json',
      'pages/content-research/agents/research-lead/instructions.md',
      'pages/content-research/goal.json',
      'pages/content-research/harness/harness.json',
      'pages/content-research/harness/task.md',
      'pages/content-research/page.json',
      'pages/content-research/ui/page.ui.json',
      'pages/facebook-videos/agents.json',
      'pages/facebook-videos/harness/harness.json',
      'pages/facebook-videos/harness/task.md',
      'pages/facebook-videos/page.json',
      'pages/facebook-videos/ui/page.ui.json',
      'pages/instagram-videos/agents.json',
      'pages/instagram-videos/goal.json',
      'pages/instagram-videos/harness/harness.json',
      'pages/instagram-videos/harness/task.md',
      'pages/instagram-videos/page.json',
      'pages/instagram-videos/ui/page.ui.json',
      'shared/instructions/00-brand-voice.md',
      'workspace.json',
    ]);
    expect(workspaceManifestSchema.safeParse(tree['workspace.json']).success).toBe(true);
    expect((tree['workspace.json'] as { pages: string[] }).pages).toEqual(['instagram-videos', 'facebook-videos', 'content-research']);
    expect(mainHarnessSchema.safeParse(tree['main-agent/harness/main-harness.json']).success).toBe(true);
    expect(harnessSchema.safeParse(tree['harness/harness.json']).success).toBe(true);
    for (const page of ['instagram-videos', 'facebook-videos', 'content-research']) {
      expect(pageSchema.safeParse(tree[`pages/${page}/page.json`]).success).toBe(true);
      expect(harnessSchema.safeParse(tree[`pages/${page}/harness/harness.json`]).success).toBe(true);
      expect(attachmentsSchema.safeParse(tree[`pages/${page}/agents.json`]).success).toBe(true);
    }
    expect(JSON.stringify(build())).toBe(JSON.stringify(tree));
  });

  it('an op that leaves the tree invalid returns its problems and the tree', () => {
    const tree = build();
    const ops: AuthoringOp[] = [
      { op: 'set_page_field', page: 'instagram-videos', field: 'domain', value: 'marketing' },
      { op: 'set_harness_field', page: 'instagram-videos', field: 'audience', value: { description: '' } },
    ];
    const result = apply(tree, ops);
    expect(result.tree).toBe(tree);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ opIndex: 1, op: 'set_harness_field', path: 'pages/instagram-videos/harness/harness.json' });
    expect(result.problems[0].message).toContain('audience.description');
  });

  it('a malformed op, a missing target and a broken final tree each name their op', () => {
    const tree = build();
    expect(apply(tree, [{ op: 'remove_page', page: 'Bad Id' }]).problems[0]).toMatchObject({ opIndex: 0, path: 'page' });
    expect(apply(tree, [{ op: 'remove_page', page: 'ghost' }]).problems[0]).toMatchObject({ opIndex: 0, op: 'remove_page' });
    const unlisted = apply(tree, [{ op: 'set_workspace_field', field: 'name', value: 'Marketing 2' }, { op: 'write_harness_prose', target: { kind: 'base' }, file: 'x.md', text: 'x' }]);
    expect(unlisted.problems).toEqual([]);
    const dropped = applyOps({ ...tree, 'harness/brand-voice.md': undefined }, [{ op: 'set_workspace_field', field: 'name', value: 'M' }], { validate: validateWorkspace });
    expect(dropped.problems[0].message).toContain('missing');
  });

  it('refuses a forbidden key through every free-form payload', () => {
    const tree = build();
    const attempts: AuthoringOp[] = [
      { op: 'set_harness_field', page: 'instagram-videos', field: 'platform', value: { id: 'instagram', requirements: { tools: ['shell'] } } },
      { op: 'set_base_harness_field', field: 'platform', value: { id: 'instagram', requirements: { steps: [] } } },
      { op: 'set_main_harness_field', field: 'clarify', value: { askWhen: [], runImmediatelyWhen: [], permissions: [] } },
      { op: 'set_attachment_field', page: 'instagram-videos', as: 'script', field: 'tools', value: { only: ['a'], add: ['shell'] } },
    ];
    for (const attempt of attempts) {
      const result = apply(tree, [attempt]);
      expect(result.tree, attempt.op).toBe(tree);
      expect(result.problems.length, attempt.op).toBeGreaterThan(0);
    }
    const harness = apply(tree, [attempts[0]]);
    expect(harness.problems[0].message).toContain('R13');
    expect(apply(tree, [{ op: 'attach_agent', page: 'instagram-videos', attachment: { as: 'x', ref: 'workspace:x', permissions: [] } as never }]).problems.length).toBeGreaterThan(0);
  });

  it('there is no op that touches shared/policies', () => {
    expect(AUTHORING_OP_NAMES.filter((name) => /polic|secret|catalog|global/.test(name))).toEqual([]);
    expect(authoringOpSchema.safeParse({ op: 'write_policy', text: '{}' }).success).toBe(false);
    for (const file of ['policy.json', '../policies/policy.md', 'policies/x.md', 'a/b.md']) {
      expect(authoringOpSchema.safeParse({ op: 'write_shared_instruction', file, text: 'x' }).success, file).toBe(false);
    }
    expect(authoringOpSchema.safeParse({ op: 'set_workspace_field', field: 'policy', value: {} }).success).toBe(false);
    let tree: WorkspaceTree = {};
    for (const operation of [...MARKETING_BUILD_OPS, ...EXTRA_OPS]) {
      expect(opFiles(operation, tree).filter((path) => path.startsWith('shared/') && !path.startsWith('shared/instructions/'))).toEqual([]);
      tree = apply(tree, [operation]).tree;
    }
    expect(Object.keys(tree).filter((path) => path.startsWith('shared/policies'))).toEqual([]);
  });

  it('exports the op schema as JSON Schema with one branch per op', () => {
    const schema = authoringOpJsonSchema() as { anyOf?: { properties?: { op?: { const?: string } } }[]; oneOf?: { properties?: { op?: { const?: string } } }[] };
    const branches = schema.anyOf ?? schema.oneOf ?? [];
    expect(branches.map((branch) => branch.properties?.op?.const).sort()).toEqual([...AUTHORING_OP_NAMES].sort());
    expect(AUTHORING_OP_NAMES).toHaveLength(26);
  });

  it('create_workspace refuses an existing workspace and other ops need one', () => {
    expect(apply(build(), [MARKETING_BUILD_OPS[0]]).problems[0].message).toContain('already exists');
    expect(apply({}, [{ op: 'create_page', page: 'x', name: 'X', description: 'X', execution: { type: 'workflow', workflow: { workflow: './workflow.json' } } }]).problems[0].path).toBe('workspace.json');
  });

  it('accepts a __proto__ key in a UI document as plain data', () => {
    const tree = build();
    const result = apply(tree, [{ op: 'write_page_ui', page: 'instagram-videos', ui: JSON.parse('{"schema":"lousho.page-ui/1","__proto__":{"a":1}}') }]);
    expect(result.problems).toEqual([]);
    expect(Object.prototype).not.toHaveProperty('a');
  });

  it('refuses R13 keys in goal and UI documents', () => {
    const tree = build();
    expect(apply(tree, [{ op: 'write_page_ui', page: 'instagram-videos', ui: { schema: 'x', tools: ['bash'] } }]).problems[0].message).toContain('R13');
    expect(apply(tree, [{ op: 'write_goal', page: 'instagram-videos', goal: { schema: 'lousho.goal/1', stop: { secrets: ['x'] } } }]).problems[0].message).toContain('R13');
  });

  it('a main-agent harness folder cannot be redirected into shared/policies or another page', () => {
    const tree = build();
    const prose = { op: 'write_harness_prose', target: { kind: 'main' }, file: 'evil.md', text: 'x' };
    const presentation = { op: 'set_main_harness_field', field: 'presentation', value: { style: 'a', followUps: 'b', revisions: 'c' } };
    for (const harness of ['shared/policies', 'pages/instagram-videos/harness', 'harness']) {
      const result = apply(tree, [{ op: 'set_workspace_field', field: 'mainAgent', value: { dir: './main-agent', harness } }, prose, presentation]);
      expect(result.tree, harness).toBe(tree);
      expect(result.problems[0], harness).toMatchObject({ opIndex: 0, op: 'set_workspace_field' });
    }
    expect(apply({}, [{ ...MARKETING_BUILD_OPS[0], mainAgent: { dir: './main-agent', harness: 'shared/policies' } }]).problems.length).toBeGreaterThan(0);
  });

  it('only known files at default locations are written, even from a tree with custom folders', () => {
    const tree = build();
    const custom = { ...tree, 'workspace.json': { ...(tree['workspace.json'] as object), harness: 'shared/policies', agents: 'shared/policies' } };
    expect(opFiles({ op: 'write_harness_prose', target: { kind: 'base' }, file: 'x.md', text: 'x' }, custom)).toEqual([]);
    expect(opFiles({ op: 'create_agent', name: 'evil', description: 'd', instructions: 'i' }, custom)).toEqual([]);
    const result = apply(custom, [{ op: 'create_agent', name: 'evil', description: 'd', instructions: 'i' }]);
    expect(result.tree).toBe(custom);
    expect(result.problems[0].message).toContain('edit it by hand');
  });

  it('setting mainAgent to null removes the main-agent files', () => {
    const tree = build();
    const result = apply(tree, [{ op: 'set_workspace_field', field: 'mainAgent', value: null }]);
    expect(result.problems).toEqual([]);
    expect(Object.keys(result.tree).filter((path) => path.startsWith('main-agent/'))).toEqual([]);
    const stray = applyOps({ ...tree, 'workspace.json': { ...(tree['workspace.json'] as object), mainAgent: null } }, [{ op: 'set_workspace_field', field: 'name', value: 'M' }], { validate: validateWorkspace });
    expect(stray.problems.map((problem) => problem.message).join('\n')).toContain('mainAgent to null');
  });

  it('the main agent has instructions prose and write_agent_prose can target it', () => {
    const tree = build();
    expect(tree['main-agent/instructions.md']).toBeDefined();
    const result = apply(tree, [{ op: 'write_agent_prose', target: 'main', text: 'Route well.' }]);
    expect(result.tree['main-agent/instructions.md']).toBe('Route well.');
    expect(apply({}, [{ op: 'create_workspace', id: 'solo', name: 'Solo', description: 'd' }, { op: 'write_agent_prose', target: 'main', text: 'x' }]).problems[0].message).toContain('no main agent');
    expect(apply(tree, [{ op: 'write_agent_prose', text: 'x' }]).problems.length).toBeGreaterThan(0);
  });

  it('a required validator runs on the final tree', () => {
    const result = applyOps(build(), [{ op: 'set_workspace_field', field: 'name', value: 'M2' }], { validate: () => [{ path: 'workspace.json', message: 'stub says no' }] });
    expect(result.problems[0]).toMatchObject({ opIndex: 0, message: 'stub says no' });
  });

  it('refuses to list or delete tree keys that climb out of a page folder', () => {
    const tree = build();
    for (const key of ['pages/instagram-videos/../../shared/policies/p.json', 'pages/instagram-videos/./x.json']) {
      const hostile = { ...tree, [key]: '{}' };
      const result = apply(hostile, [{ op: 'remove_page', page: 'instagram-videos' }]);
      expect(result.tree, key).toBe(hostile);
      expect(result.problems[0], key).toMatchObject({ opIndex: 0, path: key });
    }
  });

  it('leaves a backslash key beside a page folder alone', () => {
    const key = 'pages/instagram-videos\\..\\shared\\p.json';
    const hostile = { ...build(), [key]: '{}' };
    expect(opFiles({ op: 'remove_page', page: 'instagram-videos' }, hostile)).not.toContain(key);
    expect(apply(hostile, [{ op: 'remove_page', page: 'instagram-videos' }]).tree[key]).toBe('{}');
  });

  it('a page with a custom ui path gets a problem, not a file the runtime never reads', () => {
    const tree = build();
    const page = { ...(tree['pages/instagram-videos/page.json'] as object), ui: './custom/ui.json' };
    const custom = { ...tree, 'pages/instagram-videos/page.json': page };
    const result = apply(custom, [{ op: 'write_page_ui', page: 'instagram-videos', ui: { schema: 'x' } }]);
    expect(result.tree).toBe(custom);
    expect(result.problems[0].message).toContain('edit it by hand');
    expect(apply(custom, [{ op: 'write_page_ui', page: 'facebook-videos', ui: { schema: 'x' } }]).problems).toEqual([]);
  });

  it('setting a main agent on a workspace without one writes the same template as create_workspace', () => {
    const none = apply({}, [{ op: 'create_workspace', id: 'solo', name: 'Solo', description: 'd' }]).tree;
    const result = apply(none, [{ op: 'set_workspace_field', field: 'mainAgent', value: { dir: './main-agent' } }]);
    expect(result.problems).toEqual([]);
    expect(Object.keys(result.tree).filter((path) => path.startsWith('main-agent/')).sort()).toEqual(['main-agent/agent.json', 'main-agent/instructions.md']);
    const created = apply({}, [{ op: 'create_workspace', id: 'solo', name: 'Solo', description: 'd', mainAgent: { dir: './main-agent' } }]).tree;
    expect(result.tree['main-agent/agent.json']).toEqual(created['main-agent/agent.json']);
    expect(result.tree['main-agent/instructions.md']).toBe(created['main-agent/instructions.md']);
  });
});
