import { describe, expect, it } from 'vitest';
import { readFixtureTree } from '../__fixtures__/readTree';
import { loadWorkspace } from '../runtime/loadWorkspace';
import { profileStoreFor, resolvePageHarness } from '../runtime/resolveHarness';
import { memorySource } from '../source/memorySource';
import { defaultPageUi } from './defaultUi';
import { WORK_TYPES } from './page';
import { pageUiSchema, validateUiBindings, type UiBindingTarget } from './ui';
import { validateWorkspace } from './validate';

const FIXTURES = ['marketing', 'coding', 'ops-desk'] as const;

const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function textFiles(tree: Readonly<Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries(Object.entries(tree).map(([path, value]) => [path, typeof value === 'string' ? value : asJson(value)]));
}

const target: UiBindingTarget = {
  inputs: { schema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } },
  outputs: {
    schema: {
      type: 'object',
      properties: { script: { type: 'string' }, seconds: { type: 'integer' }, shots: { type: 'array', items: { type: 'string' } }, meta: { type: 'object' }, 'bad.name': { type: 'string' } },
    },
    artifacts: [{ name: 'video', mediaType: 'video/mp4' }],
  },
};

describe('defaultPageUi', () => {
  it('the default UI for every fixture page validates', async () => {
    for (const name of FIXTURES) {
      const tree = readFixtureTree(name);
      const workspace = await loadWorkspace(memorySource(textFiles(tree)), { mode: 'default' });
      const store = profileStoreFor(workspace);
      const next: Record<string, unknown> = { ...tree };
      for (const pageId of Object.keys(workspace.manifest.pages)) {
        const effective = resolvePageHarness(workspace, pageId, store);
        const ui = defaultPageUi(effective, 'single');
        expect(pageUiSchema.safeParse(ui).success, `${name}/${pageId}`).toBe(true);
        expect(validateUiBindings(ui, effective).filter((problem) => problem.code !== 'UI008'), `${name}/${pageId}`).toEqual([]);
        next[`pages/${pageId}/ui/page.ui.json`] = ui;
      }
      expect(validateWorkspace(next, { mode: 'default' }).filter((problem) => problem.severity === 'error'), name).toEqual([]);
    }
  });

  it('the default UI is the same for every execution type', () => {
    const uis = WORK_TYPES.map((type) => defaultPageUi(target, type));
    for (const ui of uis) expect(ui).toEqual(uis[0]);
    expect(JSON.stringify(uis[0])).toContain('"progress"');
  });

  it('builds a schema form, run controls, status, progress, one view per output field and a gallery', () => {
    expect(defaultPageUi(target, 'workflow')).toEqual({
      schema: 'lousho.ui/1',
      layout: {
        type: 'stack',
        children: [
          { type: 'schemaForm', bind: 'inputs', label: 'Inputs' },
          { type: 'row', children: [{ type: 'runButton' }, { type: 'cancelButton' }] },
          { type: 'runStatus' },
          { type: 'progress' },
          { type: 'markdown', source: 'outputs.script', label: 'script' },
          { type: 'text', source: 'outputs.seconds', label: 'seconds' },
          { type: 'table', source: 'outputs.shots', label: 'shots' },
          { type: 'json', source: 'outputs.meta', label: 'meta' },
          { type: 'artifactGallery', label: 'Artifacts' },
        ],
      },
    });
    expect(validateUiBindings(defaultPageUi(target, 'single'), target)).toEqual([]);
  });

  it('leaves out the schema form, output views and gallery when the harness declares none', () => {
    expect(defaultPageUi({}, 'single').layout).toEqual({
      type: 'stack',
      children: [{ type: 'row', children: [{ type: 'runButton' }, { type: 'cancelButton' }] }, { type: 'runStatus' }, { type: 'progress' }],
    });
  });

  it('a path or $ref output schema falls back to one json view of outputs', () => {
    for (const schema of ['schemas/out.json', { $ref: '#/$defs/out' }]) {
      const children = (defaultPageUi({ outputs: { schema } }, 'single').layout as { children: unknown[] }).children;
      expect(children.at(-1)).toEqual({ type: 'json', source: 'outputs', label: 'Output' });
    }
  });

  it('never includes reviseBox or versionList', () => {
    const text = JSON.stringify(defaultPageUi(target, 'goal-oriented'));
    expect(text).not.toContain('reviseBox');
    expect(text).not.toContain('versionList');
  });
});
