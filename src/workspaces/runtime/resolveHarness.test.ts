import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../execution/errors';
import type { WorkspaceTree } from '../contracts/baseHarness';
import { base, general, instagram, page } from '../contracts/__fixtures__/composeLayers';
import { readFixtureTree } from '../__fixtures__/readTree';
import { memorySource } from '../source/memorySource';
import { loadWorkspace, type LoadedWorkspace } from './loadWorkspace';
import { globalProfiles, workspaceProfiles } from './profileStore';
import { explainHarness, harnessCache, profileStoreFor, resolvePageHarness } from './resolveHarness';

const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const golden = '../contracts/__fixtures__/compose/base-instagram-page.json';
const GLOBAL_PAGE = 'pages/instagram-videos/page.json';

function textFiles(tree: Readonly<Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries(Object.entries(tree).map(([path, value]) => [path, typeof value === 'string' ? value : asJson(value)]));
}

async function load(files: Record<string, string>, resolveGlobal?: (ref: string) => WorkspaceTree | undefined): Promise<LoadedWorkspace> {
  return loadWorkspace(memorySource(files), { mode: 'default', ...(resolveGlobal && { resolveGlobal }) });
}

const marketing = (): Record<string, string> => textFiles(readFixtureTree('marketing'));

function withEdit(files: Record<string, string>, path: string, edit: (text: string) => string): Record<string, string> {
  return { ...files, [path]: edit(files[path] ?? '') };
}

const globalGeneral: WorkspaceTree = { 'harness.json': general.harness, 'general.md': general.texts['general.md'] };

function withGlobalAudience(range: string): Record<string, string> {
  return withEdit(marketing(), GLOBAL_PAGE, (text) => text.replace('workspace:audiences/general', `global:audiences/general@${range}`));
}

function hashesOf(workspace: LoadedWorkspace): Record<string, string> {
  return Object.fromEntries(Object.keys(workspace.manifest.pages).map((id) => [id, resolvePageHarness(workspace, id, profileStoreFor(workspace)).hash]));
}

describe('resolvePageHarness', () => {
  it('instagram effective harness equals the P0.4 golden', async () => {
    const fixture = readFixtureTree('marketing');
    const pageDoc = { ...(fixture[GLOBAL_PAGE] as object), harness: { extends: ['workspace:platforms/instagram'] } };
    const tree: WorkspaceTree = {
      'workspace.json': fixture['workspace.json'],
      'harness/harness.json': base.harness,
      'harness/brand.md': base.texts['brand.md'],
      'harness-profiles/platforms/instagram/harness.json': instagram.harness,
      'harness-profiles/platforms/instagram/voice.md': instagram.texts['voice.md'],
      'harness-profiles/platforms/instagram/format.md': instagram.texts['format.md'],
      [GLOBAL_PAGE]: pageDoc,
      'pages/instagram-videos/harness/harness.json': { ...page.harness, extends: undefined },
      'pages/instagram-videos/page.md': page.texts['page.md'],
    };
    const workspace: LoadedWorkspace = { revision: 'r1', manifest: { id: 'm', name: 'M', pages: {} }, tree, problems: [] };
    const effective = resolvePageHarness(workspace, 'instagram-videos', profileStoreFor(workspace));
    await expect(asJson(effective)).toMatchFileSnapshot(golden);
  });

  it('editing the base harness changes every page hash', async () => {
    const files = marketing();
    const before = await load(files);
    const after = await load(withEdit(files, 'harness/brand-voice.md', (text) => `${text}\nAlways add a sign-off.`));
    const a = hashesOf(before);
    const b = hashesOf(after);
    expect(Object.keys(a).length).toBeGreaterThan(1);
    for (const id of Object.keys(a)) expect(b[id], id).not.toBe(a[id]);
  });

  it('changing pages/facebook-videos/harness/task.md changes only facebook hash', async () => {
    const files = marketing();
    const before = await load(files);
    const after = await load(withEdit(files, 'pages/facebook-videos/harness/task.md', (text) => `${text}\nMention the group.`));
    const a = hashesOf(before);
    const b = hashesOf(after);
    expect(Object.keys(a).filter((id) => a[id] !== b[id])).toEqual(['facebook-videos']);
  });

  it('a global profile resolves by range through the injected store', async () => {
    const asked: string[] = [];
    const resolve = (ref: string): WorkspaceTree | undefined => {
      asked.push(ref);
      return ref === 'global:audiences/general@^1.2.0' ? globalGeneral : undefined;
    };
    const workspace = await load(withGlobalAudience('^1.2.0'), resolve);
    const effective = resolvePageHarness(workspace, 'instagram-videos', profileStoreFor(workspace, globalProfiles(resolve)));
    expect(effective.sources).toContain('global:audiences/general@^1.2.0');
    expect(effective.instructions).toContain('### From global:audiences/general@^1.2.0\n\nAssume no prior knowledge.');
    expect(asked.at(-1)).toBe('global:audiences/general@^1.2.0');
  });

  it('a global profile range change with the same content still changes the hash', async () => {
    const resolve = (): WorkspaceTree => globalGeneral;
    const one = await load(withGlobalAudience('^1.2.0'), resolve);
    const bumped = await load(withGlobalAudience('^1.2.1'), resolve);
    const a = resolvePageHarness(one, 'instagram-videos', profileStoreFor(one, globalProfiles(resolve)));
    const b = resolvePageHarness(bumped, 'instagram-videos', profileStoreFor(bumped, globalProfiles(resolve)));
    expect(b.hash).not.toBe(a.hash);
  });

  it('the cache returns the composed harness for unchanged layers', async () => {
    const workspace = await load(marketing());
    const cache = harnessCache();
    const store = profileStoreFor(workspace);
    const first = resolvePageHarness(workspace, 'instagram-videos', store, { cache });
    expect(resolvePageHarness(workspace, 'instagram-videos', store, { cache })).toBe(first);
    expect(resolvePageHarness(workspace, 'instagram-videos', store)).toEqual(first);
  });

  it('an unknown page, a missing profile and a global ref without a store throw', async () => {
    const workspace = await load(marketing());
    const store = profileStoreFor(workspace);
    expect(() => resolvePageHarness(workspace, 'nope', store)).toThrow(ValidationError);
    expect(() => store.get('workspace:platforms/missing')).toThrow(/platforms\/missing/);
    expect(() => store.get('global:tones/calm@^1.0.0')).toThrow(/no global profile store/);
    expect(() => globalProfiles(() => undefined).get('global:tones/calm@^1.0.0')).toThrow(/global:tones\/calm@\^1\.0\.0/);
    expect(() => globalProfiles(() => ({})).get('global:tones/calm@latest')).toThrow(/range/);
  });
});

describe('workspaceProfiles', () => {
  it('keeps the ref as written, with or without the workspace: prefix', async () => {
    const workspace = await load(marketing());
    const store = workspaceProfiles(workspace.tree, 'harness-profiles');
    expect(store.get('workspace:platforms/instagram').source).toBe('workspace:platforms/instagram');
    expect(store.get('platforms/instagram').source).toBe('platforms/instagram');
    expect(store.get('platforms/instagram').texts['platform.md']).toBeTypeOf('string');
  });
});

describe('explainHarness', () => {
  it('reports layer by layer in plain text', async () => {
    const workspace = await load(marketing());
    const effective = resolvePageHarness(workspace, 'instagram-videos', profileStoreFor(workspace));
    const report = explainHarness(effective);
    expect(report).toContain(effective.hash);
    const order = effective.sources.map((source) => report.indexOf(`\n${source}\n`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(report).toContain('  instructions');
  });
});
