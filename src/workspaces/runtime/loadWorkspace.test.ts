import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { folderSource } from '../source/folderSource';
import { memorySource } from '../source/memorySource';
import { readNegativeIndex, readNegativeTree, readFixtureTree } from '../__fixtures__/readTree';
import { loadWorkspace } from './loadWorkspace';
import { WorkspaceValidationError } from './validationError';

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function textFiles(tree: Readonly<Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries(Object.entries(tree).map(([path, value]) => [path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`]));
}

function folderOf(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-load-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const marketing = (): Record<string, string> => textFiles(readFixtureTree('marketing'));

describe('loadWorkspace', () => {
  it('loads the Marketing fixture with 0 errors from the folder and the in-memory source', async () => {
    const files = marketing();
    const fromMemory = await loadWorkspace(memorySource(files), { mode: 'default' });
    const fromFolder = await loadWorkspace(folderSource(folderOf({ ...files, '.lousho/note.txt': 'x', 'node_modules/pkg/index.js': 'x' })), { mode: 'default' });
    for (const loaded of [fromMemory, fromFolder]) {
      expect(loaded.problems.filter((problem) => problem.severity === 'error')).toEqual([]);
      expect(Object.keys(loaded.manifest.pages)).toEqual(['instagram-videos', 'facebook-videos', 'content-research']);
    }
    expect(Object.keys(fromFolder.tree).some((path) => path.startsWith('.lousho/') || path.startsWith('node_modules/'))).toBe(false);
    expect(fromFolder.tree).toEqual(fromMemory.tree);
    expect(fromFolder.revision).toBe(fromMemory.revision);
  });

  it('a negative fixture throws WorkspaceValidationError with its code', async () => {
    const { cases } = readNegativeIndex();
    const item = cases.find((candidate) => candidate.name === 'page-listed-missing-folder');
    expect(item).toBeDefined();
    const source = memorySource(textFiles(readNegativeTree('page-listed-missing-folder')));
    const error = await loadWorkspace(source, { mode: 'default' }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WorkspaceValidationError);
    const failure = error as WorkspaceValidationError;
    expect(failure.code).toBe('LOUSHO_WORKSPACE_INVALID');
    expect(failure.problems.map((problem) => problem.code)).toContain(item?.code);
    expect(failure.problems.every((problem) => problem.severity === 'error')).toBe(true);
  });

  it('manifest lists instagram inherits the base harness and platforms/instagram', async () => {
    const loaded = await loadWorkspace(memorySource(marketing()), { mode: 'default' });
    const page = loaded.manifest.pages['instagram-videos'];
    expect(page.inherits.shared).toEqual(expect.arrayContaining(['harness', 'shared']));
    expect(page.inherits.profiles).toEqual(['workspace:platforms/instagram', 'workspace:content-types/educational', 'workspace:audiences/general']);
    expect(page.files).toContain('pages/instagram-videos/page.json');
    expect(page.files.every((path) => path.startsWith('pages/instagram-videos/'))).toBe(true);
    expect(page.attachments).toEqual([
      { alias: 'script', ref: 'workspace:script-maker', kind: 'workspace' },
      { alias: 'video', ref: 'workspace:video-maker', kind: 'workspace' },
      { alias: 'voice', ref: 'workspace:voice-maker', kind: 'workspace' },
    ]);
  });

  it('a write after loading does not change the loaded workspace', async () => {
    const source = memorySource(marketing());
    const loaded = await loadWorkspace(source, { mode: 'default' });
    const before = JSON.stringify({ tree: loaded.tree, manifest: loaded.manifest });
    await source.write?.({ 'pages/instagram-videos/harness/task.md': 'changed after loading\n' }, { expectedRevision: loaded.revision, by: 'person:ann', message: 'edit' });
    expect(await source.revision()).not.toBe(loaded.revision);
    expect(JSON.stringify({ tree: loaded.tree, manifest: loaded.manifest })).toBe(before);
    const pinned = await loadWorkspace(source, { revision: loaded.revision, mode: 'default' });
    expect(pinned.tree).toEqual(loaded.tree);
    const latest = await loadWorkspace(source, { mode: 'default' });
    expect(latest.tree['pages/instagram-videos/harness/task.md']).toBe('changed after loading\n');
  });
});
