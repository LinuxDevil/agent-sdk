import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { baseHarnessLayer, type HarnessLayer } from './baseHarness';
import { composeHarness } from './compose';
import type { Harness } from './harness';

const golden = (name: string): string => `./__fixtures__/compose/${name}.json`;
const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function layer(source: string, harness: Omit<Harness, 'schema'>, texts: Record<string, string> = {}): HarnessLayer {
  return { source, harness: { schema: 'lousho.harness/1', ...harness }, texts };
}

const base = layer(
  'workspace base',
  {
    instructions: ['brand.md'],
    audience: { description: 'Customers of the brand.', traits: { tone: 'warm' } },
    constraints: [
      { id: 'no-competitors', text: 'Never name a competitor.' },
      { id: 'plain-language', text: 'Use plain language.' },
    ],
    evaluation: { criteria: [{ id: 'on-brand', description: 'The voice matches the brand.', rubric: 'Warm, never sarcastic.' }] },
    runtime: { limits: { maxTurns: 10, maxCostUsd: 1 } },
    context: { resources: ['shared/brand-palette.md'] },
  },
  { 'brand.md': 'Write as the brand: warm and direct.' }
);

const instagram = layer(
  'workspace:platforms/instagram',
  {
    id: 'instagram',
    version: '1.0.0',
    instructions: ['voice.md', 'format.md'],
    audience: { description: 'Followers who skim on mobile.', traits: { tone: 'playful', persona: 'creator' } },
    platform: { id: 'instagram', requirements: { aspectRatio: '4:5', captionMaxChars: 2200, hashtags: { max: 30, banned: ['#ad'] } } },
    inputs: { schema: { type: 'object', properties: { brief: { type: 'string' } }, required: ['brief'] } },
    outputs: { schema: { type: 'object', properties: { caption: { type: 'string' } } }, artifacts: [{ name: 'image', mediaType: 'image/png', required: true }] },
    capabilities: { require: ['image.generate'] },
    constraints: [{ id: 'caption-length', text: 'Keep the caption under 2200 characters.' }],
    evaluation: { criteria: [{ id: 'caption-length', description: 'The caption fits Instagram.', check: 'checks/caption-length.ts', weight: 2 }], threshold: 0.7 },
    runtime: { limits: { maxDurationMs: 120000, maxTurns: 20 }, modelHints: { temperature: 0.9 } },
    context: { resources: ['resources/instagram-specs.md'] },
  },
  { 'voice.md': 'Sound like a person, not a brochure.', 'format.md': 'Lead with a hook in the first line.' }
);

const educational = layer(
  'workspace:formats/educational',
  {
    id: 'educational',
    version: '1.0.0',
    instructions: ['teach.md'],
    audience: { description: 'Learners new to the topic.', traits: { level: 'beginner' } },
    platform: { id: 'instagram', requirements: { hashtags: { max: 10 } } },
    constraints: [{ id: 'one-idea', text: 'Teach one idea per post.' }],
    evaluation: { criteria: [{ id: 'teaches-one-idea', description: 'The post teaches exactly one idea.', rubric: 'One idea, explained simply.' }] },
    capabilities: { require: ['web.search', 'image.generate'] },
    runtime: { limits: { maxTurns: 12 }, modelHints: { temperature: 0.5, reasoning: 'medium' } },
    context: { resources: ['resources/glossary.md'] },
  },
  { 'teach.md': 'Explain one idea with one example.' }
);

const general = layer(
  'global:audiences/general@1.2.0',
  {
    id: 'general',
    version: '1.2.0',
    instructions: ['general.md'],
    audience: { description: 'A general audience.' },
    constraints: [{ id: 'no-jargon', text: 'Avoid jargon.' }],
    runtime: { limits: { maxCostUsd: 0.5 } },
  },
  { 'general.md': 'Assume no prior knowledge.' }
);

const page = layer(
  'page',
  {
    extends: ['workspace:platforms/instagram', 'workspace:formats/educational', 'global:audiences/general@1.2.0'],
    instructions: ['page.md'],
    platform: { id: 'instagram', requirements: { captionMaxChars: 1000 } },
    outputs: { schema: { merge: 'allOf', type: 'object', required: ['caption'] }, artifacts: [{ name: 'image', mediaType: 'image/jpeg', required: true }, { name: 'caption', mediaType: 'text/plain' }] },
    constraints: [{ id: 'cta', text: 'End with one call to action.' }],
    evaluation: { criteria: [{ id: 'has-cta', description: 'The post ends with a call to action.', check: 'checks/has-cta.ts' }] },
    runtime: { limits: { maxTurns: 15, maxDurationMs: 60000 } },
  },
  { 'page.md': 'Write the weekly tip post.' }
);

const profiles = [instagram, educational, general];

describe('composeHarness', () => {
  it('instagram + educational + general + page gives the snapshot', async () => {
    await expect(asJson(composeHarness([...profiles, page]))).toMatchFileSnapshot(golden('instagram-educational-general-page'));
  });

  it('base + instagram + page gives the snapshot, with base instructions first', async () => {
    const pageOnInstagram = layer('page', { ...page.harness, extends: ['workspace:platforms/instagram'] }, page.texts);
    const effective = composeHarness([base, instagram, pageOnInstagram]);
    await expect(asJson(effective)).toMatchFileSnapshot(golden('base-instagram-page'));
    expect(effective.sources).toEqual(['workspace base', 'workspace:platforms/instagram', 'page']);
    expect(effective.instructions.startsWith('### From workspace base\n\nWrite as the brand')).toBe(true);
  });

  it('a page constraint with a base id replaces the base constraint', () => {
    const override = layer('page', { constraints: [{ id: 'no-competitors', text: 'Name competitors only when comparing prices.' }] });
    const effective = composeHarness([base, override]);
    expect(effective.constraints).toEqual([
      { id: 'no-competitors', text: 'Name competitors only when comparing prices.' },
      { id: 'plain-language', text: 'Use plain language.' },
    ]);
    expect(effective.provenance['constraints["no-competitors"]']).toEqual(['page']);
    expect(effective.provenance['constraints["plain-language"]']).toEqual(['workspace base']);
  });

  it('a page criterion with a base id replaces the base criterion', () => {
    const override = layer('page', { evaluation: { criteria: [{ id: 'on-brand', description: 'The voice matches the brand.', check: 'checks/voice.ts' }] } });
    expect(composeHarness([base, override]).evaluation?.criteria).toEqual([{ id: 'on-brand', description: 'The voice matches the brand.', check: 'checks/voice.ts' }]);
  });

  it('a page limit cannot loosen a base limit', () => {
    const looser = layer('page', { runtime: { limits: { maxTurns: 50, maxCostUsd: 0.25 } } });
    const effective = composeHarness([base, looser]);
    expect(effective.runtime?.limits).toEqual({ maxTurns: 10, maxCostUsd: 0.25 });
    expect(effective.provenance['runtime.limits.maxTurns']).toEqual(['workspace base']);
    expect(effective.provenance['runtime.limits.maxCostUsd']).toEqual(['page']);
  });

  it('no base harness gives the revision 2 snapshot unchanged', async () => {
    const layer0 = baseHarnessLayer({ 'workspace.json': {}, 'pages/tips/page.json': {} });
    const layers = [layer0, ...profiles, page].filter((item): item is HarnessLayer => item !== undefined);
    await expect(asJson(composeHarness(layers))).toMatchFileSnapshot(golden('instagram-educational-general-page'));
  });

  it('the same layers in the same order give the same hash', () => {
    const first = composeHarness([base, ...profiles, page]);
    const reordered = [base, ...profiles, page].map((item) => ({ ...item, harness: Object.fromEntries(Object.entries(item.harness).reverse()) as unknown as Harness }));
    expect(composeHarness(structuredClone([base, ...profiles, page])).hash).toBe(first.hash);
    expect(composeHarness(reordered).hash).toBe(first.hash);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('swapping two extends changes the instruction order and the hash', () => {
    const swapped = layer('page', { ...page.harness, extends: ['workspace:formats/educational', 'workspace:platforms/instagram', 'global:audiences/general@1.2.0'] }, page.texts);
    const before = composeHarness([...profiles, page]);
    const after = composeHarness([...profiles, swapped]);
    expect(before.sources.slice(0, 2)).toEqual(['workspace:platforms/instagram', 'workspace:formats/educational']);
    expect(after.sources.slice(0, 2)).toEqual(['workspace:formats/educational', 'workspace:platforms/instagram']);
    expect(after.instructions.indexOf('### From workspace:formats/educational')).toBeLessThan(after.instructions.indexOf('### From workspace:platforms/instagram'));
    expect(after.hash).not.toBe(before.hash);
  });

  it('a page limit cannot loosen a profile limit', () => {
    const effective = composeHarness([...profiles, page]);
    expect(effective.runtime?.limits).toEqual({ maxDurationMs: 60000, maxTurns: 12, maxCostUsd: 0.5 });
    expect(effective.provenance['runtime.limits.maxTurns']).toEqual(['workspace:formats/educational']);
    expect(effective.provenance['runtime.limits.maxDurationMs']).toEqual(['page']);
  });

  it('the diamond applies once', () => {
    const shared = layer('workspace:shared', { instructions: ['shared.md'], constraints: [{ id: 'shared', text: 'Shared rule.' }] }, { 'shared.md': 'Shared prose.' });
    const left = layer('workspace:left', { extends: ['workspace:shared'], instructions: ['left.md'] }, { 'left.md': 'Left prose.' });
    const right = layer('workspace:right', { extends: ['workspace:shared'], instructions: ['right.md'] }, { 'right.md': 'Right prose.' });
    const top = layer('page', { extends: ['workspace:left', 'workspace:right'] });
    const effective = composeHarness([top, right, left, shared]);
    expect(effective.sources).toEqual(['workspace:shared', 'workspace:left', 'workspace:right', 'page']);
    expect(effective.instructions.match(/### From workspace:shared/g)).toHaveLength(1);
    expect(effective.provenance.instructions).toEqual(['workspace:shared', 'workspace:left', 'workspace:right']);
  });

  it('the cycle error names the path', () => {
    const a = layer('workspace:a', { extends: ['workspace:b'] });
    const b = layer('workspace:b', { extends: ['workspace:a'] });
    const top = layer('page', { extends: ['workspace:a'] });
    expect(() => composeHarness([a, b, top])).toThrow(ValidationError);
    expect(() => composeHarness([a, b, top])).toThrow('harness extends cycle: page -> workspace:a -> workspace:b -> workspace:a');
  });

  it('extends deeper than 4 is an error naming the path', () => {
    const chain = ['page', 'workspace:p1', 'workspace:p2', 'workspace:p3', 'workspace:p4', 'workspace:p5'];
    const layers = chain.map((source, index) => layer(source, chain[index + 1] ? { extends: [chain[index + 1] as string] } : {}));
    expect(() => composeHarness(layers)).toThrow(`harness extends deeper than 4: ${chain.join(' -> ')}`);
    expect(composeHarness(layers.slice(0, 4).concat(layer('workspace:p4', {}))).sources).toEqual(chain.slice(0, 5).reverse());
  });

  it('the depth check does not depend on extends order', () => {
    const pool = [
      layer('workspace:A', { extends: ['workspace:X'] }),
      layer('workspace:B', { extends: ['workspace:C'] }),
      layer('workspace:C', { extends: ['workspace:D'] }),
      layer('workspace:D', { extends: ['workspace:X'] }),
      layer('workspace:X', { extends: ['workspace:Y'] }),
      layer('workspace:Y', {}),
    ];
    const message = 'harness extends deeper than 4: page -> workspace:B -> workspace:C -> workspace:D -> workspace:X -> workspace:Y';
    expect(() => composeHarness([...pool, layer('page', { extends: ['workspace:A', 'workspace:B'] })])).toThrow(message);
    expect(() => composeHarness([...pool, layer('page', { extends: ['workspace:B', 'workspace:A'] })])).toThrow(message);
  });

  it('a layer not reached from the base or the page is an error', () => {
    const a = layer('workspace:a', {});
    const orphan = layer('workspace:orphan', { runtime: { limits: { maxTurns: 1 } } });
    const top = layer('page', { extends: ['workspace:a'] });
    expect(() => composeHarness([a, orphan, top])).toThrow(ValidationError);
    expect(() => composeHarness([a, orphan, top])).toThrow('layers not reached from the workspace base or the page: workspace:orphan');
    expect(() => composeHarness([layer('workspace:a', { extends: ['workspace:b'] }), layer('workspace:b', { extends: ['workspace:a'] })])).toThrow('workspace:a, workspace:b');
  });

  it('the hash does not depend on the input order of the pool', () => {
    const forward = composeHarness([base, ...profiles, page]);
    const backward = composeHarness([page, ...[...profiles].reverse(), base]);
    expect(backward.hash).toBe(forward.hash);
    expect(backward.sources).toEqual(forward.sources);
  });

  it('a duplicate source is an error', () => {
    expect(() => composeHarness([layer('page', {}), layer('page', { runtime: { limits: { maxTurns: 3 } } })])).toThrow("two layers have the source 'page'");
    expect(() => composeHarness([instagram, structuredClone(instagram), layer('page', { extends: ['workspace:platforms/instagram'] })])).toThrow(
      "two layers have the source 'workspace:platforms/instagram'"
    );
  });

  it('extending the workspace base or the page is an error naming the layer', () => {
    const profile = layer('workspace:p', { extends: ['workspace base'] });
    expect(() => composeHarness([base, profile, layer('page', { extends: ['workspace:p'] })])).toThrow(ValidationError);
    expect(() => composeHarness([base, profile, layer('page', { extends: ['workspace:p'] })])).toThrow("workspace:p extends 'workspace base'; only profiles can be extended");
    expect(() => composeHarness([layer('page', { extends: ['page'] })])).toThrow("page extends 'page'; only profiles can be extended");
  });

  it('an extends ref must equal a layer source exactly', () => {
    const pool = [layer('global:x@1.0.0', {}), layer('page', { extends: ['global:x@^2.0.0'] })];
    expect(() => composeHarness(pool)).toThrow("page extends 'global:x@^2.0.0', but no layer has that source");
  });

  it('provenance keys put ids and free-text keys in brackets', () => {
    const effective = composeHarness([layer('page', { outputs: { artifacts: [{ name: 'image.png', mediaType: 'image/png' }] }, platform: { id: 'x', requirements: { 'a.b': 1 } } })]);
    expect(effective.provenance['outputs.artifacts["image.png"]']).toEqual(['page']);
    expect(effective.provenance['platform.requirements["a.b"]']).toEqual(['page']);
    expect(effective.provenance['platform.id']).toEqual(['page']);
  });

  it('a __proto__ key merges as data, never as a prototype', () => {
    const requirements = JSON.parse('{"__proto__":{"polluted":1},"a":1}') as Record<string, unknown>;
    const effective = composeHarness([layer('workspace base', { platform: { id: 'x', requirements: { a: 0 } } }), layer('page', { platform: { id: 'x', requirements } })]);
    expect(Object.keys(effective.platform?.requirements ?? {})).toEqual(['a', '__proto__']);
    expect((effective.platform?.requirements as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('an extends ref with no layer is an error', () => {
    expect(() => composeHarness([layer('page', { extends: ['workspace:missing'] })])).toThrow("page extends 'workspace:missing', but no layer has that source");
  });

  it('a listed instruction file with no text is an error', () => {
    expect(() => composeHarness([layer('page', { instructions: ['page.md'] })])).toThrow("page lists instruction 'page.md', but its layer has no text for it");
  });

  it('provenance lists every source for the merged constraints', () => {
    const effective = composeHarness([base, ...profiles, page]);
    expect(effective.provenance.constraints).toEqual(['workspace base', 'workspace:platforms/instagram', 'workspace:formats/educational', 'global:audiences/general@1.2.0', 'page']);
    expect(effective.constraints?.map((constraint) => constraint.id)).toEqual(['no-competitors', 'plain-language', 'caption-length', 'one-idea', 'no-jargon', 'cta']);
    expect(effective.provenance['evaluation.criteria']).toEqual(['workspace base', 'workspace:platforms/instagram', 'workspace:formats/educational', 'page']);
  });

  it('applies each field rule', () => {
    const effective = composeHarness([base, ...profiles, page]);
    expect(effective.audience).toEqual({ description: 'A general audience.', traits: { tone: 'playful', persona: 'creator', level: 'beginner' } });
    expect(effective.platform).toEqual({ id: 'instagram', requirements: { aspectRatio: '4:5', captionMaxChars: 1000, hashtags: { max: 10, banned: ['#ad'] } } });
    expect(effective.provenance['platform.requirements["hashtags"]["max"]']).toEqual(['workspace:formats/educational']);
    expect(effective.provenance['audience.traits["tone"]']).toEqual(['workspace:platforms/instagram']);
    expect(effective.outputs?.schema).toEqual({ allOf: [{ type: 'object', properties: { caption: { type: 'string' } } }, { type: 'object', required: ['caption'] }] });
    expect(effective.provenance['outputs.schema']).toEqual(['workspace:platforms/instagram', 'page']);
    expect(effective.outputs?.artifacts).toEqual([{ name: 'image', mediaType: 'image/jpeg', required: true }, { name: 'caption', mediaType: 'text/plain' }]);
    expect(effective.capabilities?.require).toEqual(['image.generate', 'web.search']);
    expect(effective.runtime?.modelHints).toEqual({ temperature: 0.5, reasoning: 'medium' });
    expect(effective.evaluation?.threshold).toBe(0.7);
    expect(effective.context?.resources).toEqual(['shared/brand-palette.md', 'resources/instagram-specs.md', 'resources/glossary.md']);
  });

  it('a later schema without merge replaces the whole schema', () => {
    const replace = layer('page', { extends: ['workspace:platforms/instagram'], inputs: { schema: { type: 'object', properties: { topic: { type: 'string' } } } } });
    const effective = composeHarness([instagram, replace]);
    expect(effective.inputs?.schema).toEqual({ type: 'object', properties: { topic: { type: 'string' } } });
    expect(effective.provenance['inputs.schema']).toEqual(['page']);
  });

  it('a later deep-merge scalar clears the provenance under the object it replaces', () => {
    const flatten = layer('page', { extends: ['workspace:platforms/instagram'], platform: { id: 'instagram', requirements: { hashtags: 'none' } } });
    const effective = composeHarness([instagram, flatten]);
    expect(effective.platform?.requirements?.hashtags).toBe('none');
    expect(effective.provenance['platform.requirements["hashtags"]']).toEqual(['page']);
    expect(effective.provenance['platform.requirements["hashtags"]["max"]']).toBeUndefined();
  });

  it('does not change its input and holds no state between calls', () => {
    const layers = [base, ...profiles, page];
    const snapshot = structuredClone(layers);
    const first = composeHarness(layers);
    first.constraints?.push({ id: 'mutated', text: 'x' });
    expect(layers).toEqual(snapshot);
    expect(composeHarness(layers)).toEqual({ ...first, constraints: first.constraints?.slice(0, -1) });
  });

  it('no layers compose to an empty harness', () => {
    expect(composeHarness([])).toMatchObject({ sources: [], instructions: '', provenance: {} });
  });
});
