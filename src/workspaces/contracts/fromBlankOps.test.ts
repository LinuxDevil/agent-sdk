import { isDeepStrictEqual } from 'node:util';
import { describe, it, expect } from 'vitest';
import { applyOps, authoringOpSchema, opFiles, type AuthoringOp } from './authoringOps';
import { MARKETING_BUILD_OPS, MARKETING_FROM_BLANK_OPS, normal } from './__fixtures__/authoringOps';
import type { WorkspaceTree } from './baseHarness';
import { validateWorkspace } from './validate';
import { readFixtureTree } from '../__fixtures__/readTree';

const apply = (tree: WorkspaceTree, ops: readonly unknown[]) => applyOps(tree, ops, { validate: () => [] });

function marketing(): WorkspaceTree {
  const result = apply({}, MARKETING_BUILD_OPS);
  expect(result.problems).toEqual([]);
  return result.tree;
}

function changedPaths(before: WorkspaceTree, after: WorkspaceTree): string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((path) => JSON.stringify(before[path]) !== JSON.stringify(after[path]));
}

const PROFILE = { schema: 'lousho.harness/1', id: 'tone', version: '1.0.0', instructions: ['tone.md'] };

const NEW_OPS: AuthoringOp[] = [
  { op: 'set_profile', ref: 'workspace:voice/tone', profile: PROFILE, prose: { 'tone.md': 'Warm and short.' } },
  { op: 'set_resource', target: { kind: 'page', page: 'facebook-videos' }, file: 'hooks.md', text: 'Open with a question.' },
  { op: 'set_resource', target: { kind: 'base' }, file: 'glossary.txt', text: 'CTA: call to action.' },
  { op: 'set_main_model', model: 'openrouter/openai/gpt-4.1-mini' },
  { op: 'set_main_model' },
  { op: 'delete_resource', target: { kind: 'page', page: 'facebook-videos' }, file: 'hooks.md' },
  { op: 'delete_profile', ref: 'workspace:voice/tone' },
];

describe('profile, resource and main-model operations', () => {
  it('set_profile writes harness.json and its prose under harness-profiles', () => {
    const result = apply(marketing(), [NEW_OPS[0]]);
    expect(result.problems).toEqual([]);
    expect(result.tree['harness-profiles/voice/tone/harness.json']).toEqual(PROFILE);
    expect(result.tree['harness-profiles/voice/tone/tone.md']).toBe('Warm and short.');
  });

  it('set_profile refuses a profile without id and version, and a forbidden key', () => {
    const noId = apply(marketing(), [{ op: 'set_profile', ref: 'workspace:voice/tone', profile: { schema: 'lousho.harness/1' } }]);
    expect(noId.problems[0]).toMatchObject({ opIndex: 0, op: 'set_profile', path: 'harness-profiles/voice/tone/harness.json' });
    const forbidden = apply(marketing(), [{ op: 'set_profile', ref: 'workspace:voice/tone', profile: { ...PROFILE, tools: ['bash'] } }]);
    expect(forbidden.problems[0].message).toContain('R13');
  });

  it('set_profile refuses a ref that is not workspace:<path>', () => {
    for (const ref of ['global:tone@1.0.0', 'workspace:../tone', 'workspace:Tone', 'platforms/instagram']) {
      expect(authoringOpSchema.safeParse({ op: 'set_profile', ref, profile: PROFILE }).success, ref).toBe(false);
    }
  });

  it('delete_profile removes the folder and refuses a missing or nested profile', () => {
    const tree = apply(marketing(), [NEW_OPS[0]]).tree;
    const removed = apply(tree, [{ op: 'delete_profile', ref: 'workspace:voice/tone' }]);
    expect(Object.keys(removed.tree).filter((path) => path.startsWith('harness-profiles/voice/'))).toEqual([]);
    expect(apply(tree, [{ op: 'delete_profile', ref: 'workspace:voice/none' }]).problems[0].message).toContain('does not exist');
    const nested = apply(tree, [{ op: 'set_profile', ref: 'workspace:voice/tone/short', profile: { ...PROFILE, id: 'short', instructions: [] } }]).tree;
    expect(apply(nested, [{ op: 'delete_profile', ref: 'workspace:voice/tone' }]).problems[0].message).toContain('inside it');
  });

  it('set_resource writes page and base resources and delete_resource removes them', () => {
    const result = apply(marketing(), [NEW_OPS[1], NEW_OPS[2]]);
    expect(result.problems).toEqual([]);
    expect(result.tree['pages/facebook-videos/resources/hooks.md']).toBe('Open with a question.');
    expect(result.tree['harness/resources/glossary.txt']).toBe('CTA: call to action.');
    const removed = apply(result.tree, [{ op: 'delete_resource', target: { kind: 'base' }, file: 'glossary.txt' }]);
    expect('harness/resources/glossary.txt' in removed.tree).toBe(false);
    expect(apply(result.tree, [{ op: 'delete_resource', target: { kind: 'base' }, file: 'none.md' }]).problems[0].message).toContain('does not exist');
  });

  it('set_resource refuses a missing page, a folder in the name and a non-text file', () => {
    expect(apply(marketing(), [{ op: 'set_resource', target: { kind: 'page', page: 'no-such-page' }, file: 'a.md', text: 'x' }]).problems[0].message).toContain('does not exist');
    for (const file of ['a/b.md', '../a.md', 'logo.png', 'script.ts']) {
      expect(authoringOpSchema.safeParse({ op: 'set_resource', target: { kind: 'base' }, file, text: 'x' }).success, file).toBe(false);
    }
  });

  it('set_main_model sets and removes the model; it needs a main agent', () => {
    const set = apply(marketing(), [NEW_OPS[3]]);
    expect(set.tree['main-agent/agent.json']).toMatchObject({ model: 'openrouter/openai/gpt-4.1-mini' });
    const removed = apply(set.tree, [NEW_OPS[4]]);
    expect(removed.tree['main-agent/agent.json']).not.toHaveProperty('model');
    const none = apply(marketing(), [{ op: 'set_workspace_field', field: 'mainAgent', value: null }, NEW_OPS[3]]);
    expect(none.problems[0]).toMatchObject({ opIndex: 1, op: 'set_main_model' });
    expect(authoringOpSchema.safeParse({ op: 'set_main_model', model: 'no-slash' }).success).toBe(false);
  });

  it('a workspace with a custom harnessProfiles folder refuses profile ops', () => {
    const base = marketing();
    const tree = { ...base, 'workspace.json': { ...(base['workspace.json'] as object), harnessProfiles: './profiles' } };
    expect(apply(tree, [NEW_OPS[0]]).problems[0].message).toContain('custom folder');
  });

  it('each new op changes only the files opFiles lists', () => {
    let tree = marketing();
    for (const operation of NEW_OPS) {
      const listed = opFiles(operation, tree);
      const result = apply(tree, [operation]);
      expect(result.problems, operation.op).toEqual([]);
      expect(changedPaths(tree, result.tree).filter((path) => !listed.includes(path)), operation.op).toEqual([]);
      expect(changedPaths(tree, result.tree).length, operation.op).toBeGreaterThan(0);
      tree = result.tree;
    }
  });

  it('MARKETING_FROM_BLANK_OPS builds Marketing from an empty tree with 0 problems', () => {
    const result = applyOps({}, MARKETING_FROM_BLANK_OPS, { validate: validateWorkspace });
    expect(result.problems).toEqual([]);
    expect(validateWorkspace(result.tree)).toEqual([]);
  });

  it('the from-blank profiles and resources equal the Marketing fixture files', () => {
    const fixture = readFixtureTree('marketing');
    const tree = apply({}, MARKETING_FROM_BLANK_OPS).tree;
    const assets = Object.keys(fixture).filter((path) => path.startsWith('harness-profiles/') || /\/resources\/[^/]+\.md$/.test(path));
    expect(assets.length).toBe(13);
    expect(assets.filter((path) => !isDeepStrictEqual(normal(tree[path]), normal(fixture[path])))).toEqual([]);
    expect(tree['pages/instagram-videos/workflow.json']).toEqual(fixture['workflows/video-production/workflow.json']);
  });

  it('no operation writes shared/brand, shared/policies, workflows/, tools or checks', () => {
    const tree = apply({}, MARKETING_FROM_BLANK_OPS).tree;
    expect(Object.keys(tree).filter((path) => /^shared\/(brand|policies)\/|^workflows\/|\/tools\/|\/checks\//.test(path))).toEqual([]);
  });
});
