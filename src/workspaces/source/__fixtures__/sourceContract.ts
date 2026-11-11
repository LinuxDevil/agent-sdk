import { describe, expect, it } from 'vitest';
import { NoChangeError, StaleRevisionError } from '../errors';
import { revisionId } from '../revision';
import type { WorkspaceChanges, WorkspaceSource } from '../types';

export type MakeSource = (files: Record<string, string>) => Promise<WorkspaceSource>;

export const CONTRACT_FILES: Record<string, string> = {
  'workspace.json': '{"id":"demo"}\n',
  'pages/b/page.json': '{"id":"b"}\n',
  'pages/a/page.json': '{"id":"a"}\n',
  'pages-old/x.md': 'old\n',
  'shared/instructions/voice.md': 'Be brief.\n',
};

function writer(source: WorkspaceSource): NonNullable<WorkspaceSource['write']> {
  if (!source.write) throw new TypeError('the source has no writer');
  return source.write.bind(source);
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function opened(make: MakeSource): Promise<{ source: WorkspaceSource; write: NonNullable<WorkspaceSource['write']>; base: string }> {
  const source = await make(CONTRACT_FILES);
  return { source, write: writer(source), base: await source.revision() };
}

async function expectClashes(write: NonNullable<WorkspaceSource['write']>, base: string, cases: WorkspaceChanges[]): Promise<void> {
  for (const changes of cases) {
    expect(await codeOf(write(changes, { expectedRevision: base, by: 'person:ann', message: 'clash' })), Object.keys(changes).join()).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
  }
}

export function sourceContract(name: string, make: MakeSource): void {
  describe(`${name}: WorkspaceSource contract`, () => {
    it('the revision id is the sha256 of the sorted (path, contentHash) list', async () => {
      const source = await make(CONTRACT_FILES);
      expect(await source.revision()).toBe(revisionId(new Map(Object.entries(CONTRACT_FILES))));
      expect(await source.revision()).toMatch(/^[0-9a-f]{64}$/);
    });

    it('reads a file, and undefined for a missing one', async () => {
      const source = await make(CONTRACT_FILES);
      expect(await source.read('shared/instructions/voice.md')).toBe('Be brief.\n');
      expect(await source.read('pages/zzz/page.json')).toBeUndefined();
    });

    it('list is sorted and excludes .lousho/', async () => {
      const source = await make(CONTRACT_FILES);
      const write = writer(source);
      await write({ 'harness/a.md': 'a\n' }, { expectedRevision: await source.revision(), by: 'person:test', message: 'add' });
      const all = await source.list('');
      expect(all).toEqual([...Object.keys(CONTRACT_FILES), 'harness/a.md'].sort());
      expect(all.some((path) => path.startsWith('.lousho'))).toBe(false);
      expect(await source.list('pages')).toEqual(['pages/a/page.json', 'pages/b/page.json']);
      expect(await source.list('pages/')).toEqual(['pages/a/page.json', 'pages/b/page.json']);
    });

    it('a stale expectedRevision is refused', async () => {
      const { source, write, base } = await opened(make);
      const first = await write({ 'workspace.json': '{"id":"one"}\n' }, { expectedRevision: base, by: 'person:ann', message: 'one' });
      const stale = write({ 'workspace.json': '{"id":"two"}\n' }, { expectedRevision: base, by: 'person:bob', message: 'two' });
      await expect(stale).rejects.toBeInstanceOf(StaleRevisionError);
      await expect(stale).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_STALE_REVISION', expectedRevision: base, currentRevision: first.revision });
      expect(await source.read('workspace.json')).toBe('{"id":"one"}\n');
      expect(await source.revision()).toBe(first.revision);
      expect(await source.history()).toHaveLength(1);
    });

    it('a read at an old revision returns the old content', async () => {
      const { source, write, base } = await opened(make);
      const meta = await write({ 'workspace.json': '{"id":"new"}\n', 'pages-old/x.md': null }, { expectedRevision: base, by: 'person:ann', message: 'edit' });
      expect(await source.read('workspace.json')).toBe('{"id":"new"}\n');
      expect(await source.read('pages-old/x.md')).toBeUndefined();
      expect(await source.read('workspace.json', { revision: base })).toBe('{"id":"demo"}\n');
      expect(await source.read('pages-old/x.md', { revision: base })).toBe('old\n');
      expect(await source.list('pages-old', { revision: base })).toEqual(['pages-old/x.md']);
      expect(await source.read('workspace.json', { revision: meta.revision })).toBe('{"id":"new"}\n');
    });

    it('history lists revisions newest first with their parent and kind', async () => {
      const { source, write, base } = await opened(make);
      const one = await write({ 'a.md': '1' }, { expectedRevision: base, by: 'person:ann', message: 'one' });
      const two = await write({ 'a.md': '2' }, { expectedRevision: one.revision, by: 'person:bob', message: 'two', kind: 'improvement' });
      expect(one).toMatchObject({ parent: base, by: 'person:ann', message: 'one', kind: 'authoring' });
      expect(Number.isNaN(Date.parse(one.createdAt))).toBe(false);
      expect(await source.history()).toEqual([two, one]);
      expect(two).toMatchObject({ parent: one.revision, kind: 'improvement' });
    });

    it('numbers writes with seq and keeps a repeated revision id as a new entry', async () => {
      const { source, write, base } = await opened(make);
      const one = await write({ 'a.md': '1' }, { expectedRevision: base, by: 'person:ann', message: 'add' });
      const two = await write({ 'a.md': null }, { expectedRevision: one.revision, by: 'person:ann', message: 'undo', kind: 'rollback' });
      const three = await write({ 'a.md': '1' }, { expectedRevision: two.revision, by: 'person:ann', message: 'redo' });
      expect([one.seq, two.seq, three.seq]).toEqual([1, 2, 3]);
      expect(three.revision).toBe(one.revision);
      expect((await source.history()).map((meta) => meta.seq)).toEqual([3, 2, 1]);
    });

    it('a write that changes nothing is refused and records nothing', async () => {
      const { source, write, base } = await opened(make);
      const same = write({ 'workspace.json': CONTRACT_FILES['workspace.json'], 'missing.md': null }, { expectedRevision: base, by: 'person:ann', message: 'noop' });
      await expect(same).rejects.toBeInstanceOf(NoChangeError);
      await expect(same).rejects.toMatchObject({ code: 'LOUSHO_WORKSPACE_NO_CHANGE', revision: base });
      expect(await source.history()).toEqual([]);
    });

    it('commits the audit entry with the revision', async () => {
      const source = await make(CONTRACT_FILES);
      const write = writer(source);
      const audit = { actor: 'person:ann' as const, action: 'apply' as const, reason: 'tighten the voice' };
      const meta = await write({ 'a.md': '1' }, { expectedRevision: await source.revision(), by: 'person:ann', message: 'add', audit });
      expect(meta.audit).toEqual(audit);
      expect((await source.history())[0]).toEqual(meta);
    });

    it('a write that restores an earlier tree gives the earlier revision id', async () => {
      const { write, base } = await opened(make);
      const one = await write({ 'a.md': '1' }, { expectedRevision: base, by: 'person:ann', message: 'add' });
      const back = await write({ 'a.md': null }, { expectedRevision: one.revision, by: 'person:ann', message: 'rollback', kind: 'rollback' });
      expect(back.revision).toBe(base);
    });

    it('refuses paths that leave the workspace or enter .lousho/', async () => {
      const source = await make(CONTRACT_FILES);
      const write = writer(source);
      const expectedRevision = await source.revision();
      for (const path of ['../secret', '/etc/passwd', 'a/../../b', 'a//b', './a', 'a\\b', '.lousho/revisions/index.json', 'node_modules/x/index.js']) {
        expect(await codeOf(source.read(path)), path).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
        expect(await codeOf(write({ [path]: 'x' }, { expectedRevision, by: 'person:eve', message: 'escape' })), path).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
      }
      expect(await codeOf(source.list('../'))).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
      expect(await source.revision()).toBe(expectedRevision);
    });

    it('refuses reserved folders whatever their case or Unicode form', async () => {
      const { source, write, base } = await opened(make);
      for (const path of ['.Git/x', '.GIT/hooks/pre-commit', '.LOUSHO/revisions/index.json', 'Node_Modules/x.js', 'pages/.git/config', '.Lousho/pending.json']) {
        expect(await codeOf(source.read(path)), path).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
        expect(await codeOf(write({ [path]: 'x' }, { expectedRevision: base, by: 'person:eve', message: 'escape' })), path).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
      }
    });

    it('refuses a tree with two paths equal after Unicode normalisation and case folding', async () => {
      const { write, base } = await opened(make);
      const nfc = 'pages/caf\u00e9.md';
      const nfd = 'pages/cafe\u0301.md';
      await expectClashes(write, base, [{ 'Pages/a/page.json': 'x' }, { [nfc]: '1', [nfd]: '2' }, { 'WORKSPACE.JSON': '{}' }]);
    });

    it('refuses a write that deletes one path and writes its case or Unicode alias, in either order', async () => {
      const { source, write } = await opened(make);
      const expectedRevision = (await write({ 'A.md': 'old' }, { expectedRevision: await source.revision(), by: 'person:ann', message: 'add' })).revision;
      for (const changes of [{ 'a.md': 'new', 'A.md': null }, { 'A.md': null, 'a.md': 'new' }] as WorkspaceChanges[]) {
        expect(await codeOf(write(changes, { expectedRevision, by: 'person:ann', message: 'alias' })), Object.keys(changes).join()).toBe('LOUSHO_WORKSPACE_PATH_INVALID');
        expect(await source.read('A.md')).toBe('old');
        expect(await source.revision()).toBe(expectedRevision);
      }
    });

    it('refuses a tree where a file is also a folder', async () => {
      const { write, base } = await opened(make);
      await expectClashes(write, base, [{ 'workspace.json/x': '1' }, { pages: '1' }, { b: '1', 'b/c': '2' }]);
    });

    it('history starts at the first write and its parent, the starting tree, stays readable', async () => {
      const { source, write, base } = await opened(make);
      expect(await source.history()).toEqual([]);
      let expectedRevision = base;
      for (const n of [1, 2, 3, 4]) expectedRevision = (await write({ 'a.md': String(n) }, { expectedRevision, by: 'person:ann', message: `${n}` })).revision;
      const history = await source.history();
      expect(history.at(-1)).toMatchObject({ seq: 1, parent: base });
      expect(await source.read('workspace.json', { revision: base })).toBe(CONTRACT_FILES['workspace.json']);
    });

    it('an unknown revision is refused', async () => {
      const source = await make(CONTRACT_FILES);
      expect(await codeOf(source.read('workspace.json', { revision: 'f'.repeat(64) }))).toBe('LOUSHO_WORKSPACE_REVISION_UNKNOWN');
      expect(await codeOf(source.list('', { revision: '../../etc' }))).toBe('LOUSHO_WORKSPACE_REVISION_UNKNOWN');
    });

    it('carries the project and workspace ids', async () => {
      const source = await make(CONTRACT_FILES);
      expect(source.ref).toEqual({ projectId: expect.any(String), workspaceId: expect.any(String) });
    });
  });
}
