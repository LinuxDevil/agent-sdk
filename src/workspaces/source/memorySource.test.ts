import { describe, expect, it } from 'vitest';
import { memorySource } from './memorySource';
import { readSourceTree } from './tree';
import { CONTRACT_FILES, sourceContract } from './__fixtures__/sourceContract';

sourceContract('memorySource', async (files) => memorySource(files));

describe('memorySource', () => {
  it('defaults its ref and takes the given ids', () => {
    expect(memorySource({}).ref).toEqual({ projectId: 'default', workspaceId: 'workspace' });
    expect(memorySource({}, { ref: { projectId: 'acme', workspaceId: 'marketing' } }).ref).toEqual({ projectId: 'acme', workspaceId: 'marketing' });
  });

  it('refuses initial files outside the workspace', () => {
    expect(() => memorySource({ '../x': 'y' })).toThrow(/LOUSHO_WORKSPACE_PATH_INVALID/);
  });

  it('reads a whole tree pinned to the revision it started on', async () => {
    const source = memorySource(CONTRACT_FILES);
    const base = await source.revision();
    await source.write?.({ 'workspace.json': '{}' }, { expectedRevision: base, by: 'person:ann', message: 'edit' });
    const pinned = await readSourceTree(source, { revision: base });
    expect(pinned).toEqual({ revision: base, tree: CONTRACT_FILES });
    expect((await readSourceTree(source)).tree['workspace.json']).toBe('{}');
  });
});
