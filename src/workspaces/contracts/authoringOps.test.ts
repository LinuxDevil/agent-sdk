import { describe, it, expect } from 'vitest';
import { attachmentsSchema } from './agentRefs';
import { AUTHORING_OP_NAMES, applyOps, authoringOpJsonSchema, authoringOpSchema, opFiles, type AuthoringOp } from './authoringOps';
import { MARKETING_BUILD_OPS } from './authoringOps.fixtures';
import type { WorkspaceTree } from './baseHarness';
import { harnessSchema } from './harness';
import { mainHarnessSchema } from './mainHarness';
import { pageSchema } from './page';
import { workspaceManifestSchema } from './workspace';

function build(): WorkspaceTree {
  const result = applyOps({}, MARKETING_BUILD_OPS);
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
  { op: 'remove_extends', page: 'instagram-videos', ref: 'platforms/instagram' },
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
      const result = applyOps(tree, [operation]);
      expect(result.problems).toEqual([]);
      expect(listed.length).toBeGreaterThan(0);
      expect(changedPaths(tree, result.tree).filter((path) => !listed.includes(path))).toEqual([]);
      tree = result.tree;
    }
    for (const operation of EXTRA_OPS) {
      const listed = opFiles(operation, tree);
      const result = applyOps(tree, [operation]);
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
      'harness/harness.json',
      'harness/voice.md',
      'main-agent/harness/main-harness.json',
      'main-agent/harness/routing.md',
      'pages/facebook-videos/agents.json',
      'pages/facebook-videos/harness/harness.json',
      'pages/facebook-videos/harness/task.md',
      'pages/facebook-videos/page.json',
      'pages/facebook-videos/ui/page.ui.json',
      'pages/instagram-videos/agents.json',
      'pages/instagram-videos/harness/harness.json',
      'pages/instagram-videos/harness/task.md',
      'pages/instagram-videos/page.json',
      'pages/instagram-videos/ui/page.ui.json',
      'pages/instagram-videos/workflow.json',
      'shared/instructions/00-brand-voice.md',
      'workspace.json',
    ]);
    expect(workspaceManifestSchema.safeParse(tree['workspace.json']).success).toBe(true);
    expect((tree['workspace.json'] as { pages: string[] }).pages).toEqual(['facebook-videos', 'instagram-videos']);
    expect(mainHarnessSchema.safeParse(tree['main-agent/harness/main-harness.json']).success).toBe(true);
    expect(harnessSchema.safeParse(tree['harness/harness.json']).success).toBe(true);
    for (const page of ['facebook-videos', 'instagram-videos']) {
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
    const result = applyOps(tree, ops);
    expect(result.tree).toBe(tree);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ opIndex: 1, op: 'set_harness_field', path: 'pages/instagram-videos/harness/harness.json' });
    expect(result.problems[0].message).toContain('audience.description');
  });

  it('a malformed op, a missing target and a broken final tree each name their op', () => {
    const tree = build();
    expect(applyOps(tree, [{ op: 'remove_page', page: 'Bad Id' }]).problems[0]).toMatchObject({ opIndex: 0, path: 'page' });
    expect(applyOps(tree, [{ op: 'remove_page', page: 'ghost' }]).problems[0]).toMatchObject({ opIndex: 0, op: 'remove_page' });
    const unlisted = applyOps(tree, [{ op: 'set_workspace_field', field: 'name', value: 'Marketing 2' }, { op: 'write_harness_prose', target: { kind: 'base' }, file: 'x.md', text: 'x' }]);
    expect(unlisted.problems).toEqual([]);
    const dropped = applyOps({ ...tree, 'harness/voice.md': undefined }, [{ op: 'set_workspace_field', field: 'name', value: 'M' }]);
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
      const result = applyOps(tree, [attempt]);
      expect(result.tree, attempt.op).toBe(tree);
      expect(result.problems.length, attempt.op).toBeGreaterThan(0);
    }
    const harness = applyOps(tree, [attempts[0]]);
    expect(harness.problems[0].message).toContain('R13');
    expect(applyOps(tree, [{ op: 'attach_agent', page: 'instagram-videos', attachment: { as: 'x', ref: 'workspace:x', permissions: [] } as never }]).problems.length).toBeGreaterThan(0);
    expect(applyOps(tree, [{ op: 'write_page_ui', page: 'instagram-videos', ui: JSON.parse('{"__proto__":{"a":1}}') }]).problems).toEqual([]);
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
      tree = applyOps(tree, [operation]).tree;
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
    expect(applyOps(build(), [MARKETING_BUILD_OPS[0]]).problems[0].message).toContain('already exists');
    expect(applyOps({}, [{ op: 'create_page', page: 'x', name: 'X', description: 'X', execution: { type: 'workflow', workflow: { workflow: './workflow.json' } } }]).problems[0].path).toBe('workspace.json');
  });
});
