import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWorkspace } from '../contracts/validate';
import { readFixtureTree } from '../__fixtures__/readTree';
import { folderSource } from './folderSource';
import { memorySource } from './memorySource';
import { readSourceTree } from './tree';
import { applyChanges, revisionId } from './revision';
import type { RevisionMeta, WorkspaceChanges } from './types';
import { CONTRACT_FILES, sourceContract } from './__fixtures__/sourceContract';

function plantJournal(dir: string, changes: WorkspaceChanges): RevisionMeta {
  const base = new Map(Object.entries(CONTRACT_FILES));
  const meta: RevisionMeta = { seq: 1, revision: revisionId(applyChanges(base, changes)), parent: revisionId(base), createdAt: new Date(0).toISOString(), by: 'person:ann', message: 'crashed', kind: 'authoring' };
  mkdirSync(join(dir, '.lousho', 'revisions'), { recursive: true });
  writeFileSync(join(dir, '.lousho', 'revisions', 'pending.json'), JSON.stringify({ meta, changes }));
  return meta;
}

describe('folderSource after a crash', () => {
  it('finishes a write whose journal was committed, on next access', async () => {
    const dir = folderWith(CONTRACT_FILES);
    const meta = plantJournal(dir, { 'a.md': 'new', 'workspace.json': '{}', 'pages-old/x.md': null });
    writeFileSync(join(dir, 'a.md'), 'new');
    const source = folderSource(dir);
    expect(await source.revision()).toBe(meta.revision);
    expect(await source.read('workspace.json')).toBe('{}');
    expect(await source.read('pages-old/x.md')).toBeUndefined();
    expect(await source.history()).toEqual([meta]);
    expect(existsSync(join(dir, '.lousho', 'revisions', 'pending.json'))).toBe(false);
  });

  it('leaves the old tree when the crash came before the journal, and ignores leftover temp files', async () => {
    const dir = folderWith({ ...CONTRACT_FILES, 'workspace.json.0b1c.lousho-tmp': 'half' });
    const source = folderSource(dir);
    expect(await source.revision()).toBe(await memorySource(CONTRACT_FILES).revision());
    expect(await source.history()).toEqual([]);
  });

  it('sets aside a journal that names a path outside the folder, fails that call once, then works', async () => {
    const outside = tempDir();
    const dir = folderWith(CONTRACT_FILES);
    const meta = plantJournal(dir, { 'a.md': 'x' });
    writeFileSync(join(dir, '.lousho', 'revisions', 'pending.json'), JSON.stringify({ meta, changes: { [`../${outside.split('/').pop()}/planted.md`]: 'x' } }));
    const source = folderSource(dir);
    expect(await codeOf(source.revision())).toBe('LOUSHO_WORKSPACE_SOURCE_CORRUPT');
    expect(readdirSync(outside)).toEqual([]);
    expect(await source.revision()).toBe(await memorySource(CONTRACT_FILES).revision());
    expect(readdirSync(join(dir, '.lousho', 'revisions')).some((name) => name.startsWith('pending.failed-'))).toBe(true);
  });

  it('sets aside a malformed journal and puts back the files it named from the parent snapshot', async () => {
    const dir = folderWith(CONTRACT_FILES);
    const source = folderSource(dir);
    const base = await source.revision();
    await source.write!({ 'a.md': '1' }, { expectedRevision: base, by: 'person:ann', message: 'one' });
    const meta = { seq: 2, revision: 'a'.repeat(64), parent: base, createdAt: 'x', by: 'person:ann', message: 'bad', kind: 'authoring' };
    writeFileSync(join(dir, '.lousho', 'revisions', 'pending.json'), JSON.stringify({ meta, changes: { 'a.md': 'half', 'b/c.md': 7 } }));
    expect(await codeOf(source.read('a.md'))).toBe('LOUSHO_WORKSPACE_SOURCE_CORRUPT');
    writeFileSync(join(dir, '.lousho', 'revisions', 'pending.json'), JSON.stringify({ meta, changes: { 'workspace.json': 'half', 'a.md/x': 'y' } }));
    writeFileSync(join(dir, 'workspace.json'), 'half');
    expect(await codeOf(source.read('a.md'))).toBe('LOUSHO_WORKSPACE_SOURCE_CORRUPT');
    expect(await source.read('workspace.json')).toBe(CONTRACT_FILES['workspace.json']);
    expect((await source.history()).map((entry) => entry.seq)).toEqual([1]);
  });

  it('refuses a damaged revision index', async () => {
    const dir = folderWith(CONTRACT_FILES);
    mkdirSync(join(dir, '.lousho', 'revisions'), { recursive: true });
    writeFileSync(join(dir, '.lousho', 'revisions', 'index.json'), JSON.stringify([{ seq: 'one' }]));
    expect(await codeOf(folderSource(dir).history())).toBe('LOUSHO_WORKSPACE_SOURCE_CORRUPT');
  });
});

const FIXTURES = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const made: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-source-'));
  made.push(dir);
  return dir;
}

function folderWith(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

sourceContract('folderSource', async (files) => folderSource(folderWith(files)));

describe('folderSource and memorySource', () => {
  it('the same files give the same revision id on both sources', async () => {
    const folder = folderSource(folderWith(CONTRACT_FILES));
    const memory = memorySource(CONTRACT_FILES);
    expect(await folder.revision()).toBe(await memory.revision());
    const changes = { 'harness/a.md': 'a\n', 'pages-old/x.md': null };
    const fromFolder = await folder.write?.(changes, { expectedRevision: await folder.revision(), by: 'person:ann', message: 'edit' });
    const fromMemory = await memory.write?.(changes, { expectedRevision: await memory.revision(), by: 'person:ann', message: 'edit' });
    expect(fromFolder?.revision).toBe(fromMemory?.revision);
  });

  it('a fixture folder reads into the same WorkspaceTree verdict as the fixture reader', async () => {
    for (const name of ['marketing', 'coding', 'ops-desk']) {
      const { revision, tree } = await readSourceTree(folderSource(join(FIXTURES, name)));
      expect(validateWorkspace(tree, { mode: 'default' })).toEqual(validateWorkspace(readFixtureTree(name), { mode: 'default' }));
      expect(Object.keys(tree).sort()).toEqual(Object.keys(readFixtureTree(name)).sort());
      expect(await memorySource(tree).revision()).toBe(revision);
    }
  });
});

describe('folderSource', () => {
  it('defaults its ref to the folder name', () => {
    expect(folderSource('/tmp/marketing').ref).toEqual({ projectId: 'default', workspaceId: 'marketing' });
  });

  it('keeps revision metadata and snapshots in .lousho/revisions/ across instances', async () => {
    const dir = folderWith(CONTRACT_FILES);
    const first = folderSource(dir);
    const base = await first.revision();
    const meta = await first.write?.({ 'workspace.json': '{}' }, { expectedRevision: base, by: 'person:ann', message: 'edit' });
    expect(readdirSync(join(dir, '.lousho', 'revisions')).sort()).toEqual([`${base}.json`, `${meta?.revision}.json`, 'index.json'].sort());
    const again = folderSource(dir);
    expect(await again.history()).toEqual([meta]);
    expect(await again.read('workspace.json', { revision: base })).toBe(CONTRACT_FILES['workspace.json']);
    expect(readdirSync(dir).filter((name) => name.endsWith('.lousho-tmp'))).toEqual([]);
  });

  it('keeps snapshots for the last `keep` revisions only', async () => {
    const source = folderSource(folderWith(CONTRACT_FILES), { keep: 2 });
    const base = await source.revision();
    let expectedRevision = base;
    const metas = [];
    for (const n of [1, 2, 3]) {
      const meta = await source.write!({ 'a.md': String(n) }, { expectedRevision, by: 'person:ann', message: `${n}` });
      metas.push(meta);
      expectedRevision = meta.revision;
    }
    expect(await source.read('a.md', { revision: base })).toBeUndefined();
    expect(await codeOf(source.read('a.md', { revision: metas[0].revision }))).toBe('LOUSHO_WORKSPACE_REVISION_UNKNOWN');
    expect(await source.read('a.md', { revision: metas[1].revision })).toBe('2');
    expect(await source.history()).toHaveLength(3);
  });

  it('two concurrent writes with the same expectedRevision: one wins, one is stale', async () => {
    const source = folderSource(folderWith(CONTRACT_FILES));
    const expectedRevision = await source.revision();
    const results = await Promise.allSettled([
      source.write!({ 'a.md': 'one' }, { expectedRevision, by: 'person:ann', message: 'one' }),
      source.write!({ 'a.md': 'two' }, { expectedRevision, by: 'person:bob', message: 'two' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await source.history()).toHaveLength(1);
  });

  it('two instances writing at once both land, with distinct seq', async () => {
    const dir = folderWith(CONTRACT_FILES);
    const [one, two] = [folderSource(dir), folderSource(dir)];
    const base = await one.revision();
    const results = await Promise.allSettled([
      one.write!({ 'a.md': 'one' }, { expectedRevision: base, by: 'person:ann', message: 'one' }),
      two.write!({ 'b.md': 'two' }, { expectedRevision: base, by: 'person:bob', message: 'two' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const head = await two.revision();
    const loser = results[0].status === 'rejected' ? { source: one, changes: { 'a.md': 'one' } as WorkspaceChanges } : { source: two, changes: { 'b.md': 'two' } as WorkspaceChanges };
    await loser.source.write!(loser.changes, { expectedRevision: head, by: 'person:bob', message: 'retry' });
    expect(await one.read('a.md')).toBe('one');
    expect(await one.read('b.md')).toBe('two');
    expect((await one.history()).map((meta) => meta.seq)).toEqual([2, 1]);
  });

  it('two instances making their first write at once create the metadata folders without a race', async () => {
    const dirs = [folderWith(CONTRACT_FILES), folderWith(CONTRACT_FILES)];
    for (const dir of dirs) {
      const [one, two] = [folderSource(dir), folderSource(dir)];
      const base = await one.revision();
      const results = await Promise.allSettled([
        one.write!({ 'deep/x/a.md': 'one' }, { expectedRevision: base, by: 'person:ann', message: 'one' }),
        two.write!({ 'deep/x/b.md': 'two' }, { expectedRevision: base, by: 'person:bob', message: 'two' }),
      ]);
      const codes = results.map((result) => (result.status === 'rejected' ? (result.reason as { code?: string }).code : 'ok')).sort();
      expect(codes).toEqual(['LOUSHO_WORKSPACE_STALE_REVISION', 'ok']);
    }
  });

  it('a hand edit to the folder changes the current revision', async () => {
    const dir = folderWith(CONTRACT_FILES);
    const source = folderSource(dir);
    const before = await source.revision();
    writeFileSync(join(dir, 'workspace.json'), '{"id":"hand"}');
    expect(await source.revision()).not.toBe(before);
    expect(await codeOf(source.write!({ 'a.md': 'x' }, { expectedRevision: before, by: 'person:ann', message: 'late' }))).toBe('LOUSHO_WORKSPACE_STALE_REVISION');
  });

  it('ignores node_modules/ and .git/', async () => {
    const source = folderSource(folderWith({ ...CONTRACT_FILES, 'node_modules/x/index.js': 'x', '.git/HEAD': 'ref' }));
    expect(await source.revision()).toBe(await memorySource(CONTRACT_FILES).revision());
  });

  it('refuses a missing folder', async () => {
    expect(await codeOf(folderSource(join(tempDir(), 'nope')).revision())).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
  });
});

describe('folderSource refuses to escape its folder', () => {
  it('a symlinked file pointing outside', async () => {
    const outside = folderWith({ 'secret.txt': 'top secret' });
    const dir = folderWith(CONTRACT_FILES);
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'leak.md'));
    const source = folderSource(dir);
    expect(await codeOf(source.read('leak.md'))).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
    expect(await source.list('')).not.toContain('leak.md');
    expect(await source.revision()).toBe(await memorySource(CONTRACT_FILES).revision());
  });

  it('a symlinked folder pointing outside, for reads and writes', async () => {
    const outside = folderWith({ 'secret.txt': 'top secret' });
    const dir = folderWith(CONTRACT_FILES);
    symlinkSync(outside, join(dir, 'ext'));
    const source = folderSource(dir);
    expect(await codeOf(source.read('ext/secret.txt'))).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
    expect(await source.list('')).toEqual(Object.keys(CONTRACT_FILES).sort());
    const expectedRevision = await source.revision();
    const write = source.write!({ 'ext/planted.md': 'x' }, { expectedRevision, by: 'person:eve', message: 'plant' });
    expect(await codeOf(write)).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
    expect(existsSync(join(outside, 'planted.md'))).toBe(false);
  });

  it('a .lousho folder symlinked outside', async () => {
    const outside = folderWith({});
    const dir = folderWith(CONTRACT_FILES);
    symlinkSync(outside, join(dir, '.lousho'));
    const source = folderSource(dir);
    const write = source.write!({ 'a.md': 'x' }, { expectedRevision: await source.revision(), by: 'person:eve', message: 'plant' });
    expect(await codeOf(write)).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('a symlinked folder inside the workspace', async () => {
    const dir = folderWith(CONTRACT_FILES);
    symlinkSync(join(dir, 'pages'), join(dir, 'loop'));
    expect(await folderSource(dir).list('')).toEqual(Object.keys(CONTRACT_FILES).sort());
  });

  it('leaves names that break the path rules out of the tree instead of failing', async () => {
    const dir = folderWith({ ...CONTRACT_FILES, 'pages/.GIT/config': 'x', 'odd\\name.md': 'y' });
    expect(await folderSource(dir).list('')).toEqual(Object.keys(CONTRACT_FILES).sort());
  });

  it('refuses case-folded reserved folders on disk-backed writes', async () => {
    const dir = folderWith(CONTRACT_FILES);
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    const source = folderSource(dir);
    const write = source.write!({ '.Git/hooks/pre-commit': 'rm -rf /' }, { expectedRevision: await source.revision(), by: 'person:eve', message: 'hook' });
    expect(await codeOf(write)).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
    expect(readdirSync(join(dir, '.git', 'hooks'))).toEqual([]);
  });

  it('follows a symlinked file inside the workspace and skips a dangling one', async () => {
    const dir = folderWith(CONTRACT_FILES);
    symlinkSync(join(dir, 'pages-old', 'x.md'), join(dir, 'alias.md'));
    symlinkSync(join(dir, 'missing.md'), join(dir, 'dangling.md'));
    const source = folderSource(dir);
    expect(await source.read('alias.md')).toBe('old\n');
    expect(await source.list('')).toContain('alias.md');
    expect(await source.list('')).not.toContain('dangling.md');
  });

  it('dot-dot and absolute paths', async () => {
    const source = folderSource(folderWith(CONTRACT_FILES));
    for (const path of ['../../etc/passwd', '/etc/passwd', 'pages/../../x']) expect(await codeOf(source.read(path)), path).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
  });
});

describe('folderSource bounds its reads', () => {
  it('a file over maxFileBytes', async () => {
    const source = folderSource(folderWith({ ...CONTRACT_FILES, 'big.md': 'x'.repeat(101) }), { maxFileBytes: 100 });
    expect(await codeOf(source.read('big.md'))).toBe('LOUSHO_WORKSPACE_SOURCE_LIMIT');
    expect(await codeOf(source.revision())).toBe('LOUSHO_WORKSPACE_SOURCE_LIMIT');
    expect(await source.read('workspace.json')).toBe(CONTRACT_FILES['workspace.json']);
  });

  it('more files than maxFiles', async () => {
    const source = folderSource(folderWith(CONTRACT_FILES), { maxFiles: 3 });
    expect(await codeOf(source.list(''))).toBe('LOUSHO_WORKSPACE_SOURCE_LIMIT');
  });

  it('a tree over maxTreeBytes', async () => {
    const source = folderSource(folderWith(CONTRACT_FILES), { maxTreeBytes: 20 });
    expect(await codeOf(source.revision())).toBe('LOUSHO_WORKSPACE_SOURCE_LIMIT');
  });
});
