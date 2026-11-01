import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { workspaceIdFor } from '../workspaceId';
import { WorkspaceExistsError, WorkspaceRegistry } from '../workspaceRegistry';

/**
 * The workspace registry (`workspaces.json`): the launch folder is
 * `ensure`d on every start, `add` validates the folder and rejects
 * duplicates by id (never by the raw path string), and every
 * read-modify-write runs inside `withAgentLock('workspaces:registry')`
 * so parallel adds both land. Timestamps come from an injected `now` so
 * the tests can see `lastOpenedAt` move.
 */
describe('WorkspaceRegistry', () => {
  let dir: string;
  let file: string;
  let tick: number;
  let registry: WorkspaceRegistry;

  /** One folder the registry can point at, under the temp dir. */
  function folder(name: string): string {
    const root = path.join(dir, name);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w01-reg-'));
    file = path.join(dir, 'state', 'workspaces.json');
    tick = Date.parse('2026-01-01T00:00:00.000Z');
    registry = new WorkspaceRegistry(file, () => new Date(tick));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('list returns [] when the file does not exist', async () => {
    expect(await registry.list()).toEqual([]);
  });

  it('ensure adds a new folder, and a second ensure keeps one entry and bumps lastOpenedAt', async () => {
    const a = folder('alpha');
    const first = await registry.ensure(a);
    expect(first).toMatchObject({
      id: workspaceIdFor(a),
      root: expect.any(String),
      addedAt: new Date(tick).toISOString(),
      lastOpenedAt: new Date(tick).toISOString(),
    });
    expect(await registry.list()).toHaveLength(1);

    tick += 60_000;
    const again = await registry.ensure(a);
    expect(again.id).toBe(first.id);
    expect(again.addedAt).toBe(first.addedAt);
    expect(again.lastOpenedAt).toBe(new Date(tick).toISOString());
    expect(await registry.list()).toHaveLength(1);
  });

  it.each<[string, unknown]>([
    ['a non-string', 42],
    ['an empty string', '   '],
    // Also missing on disk - the INVALID check must run before the stat.
    ['a relative path', path.join('some', 'relative', 'folder')],
  ])('add rejects %s with LOUSHO_WORKSPACE_ROOT_INVALID', async (_label, root) => {
    await expect(registry.add(root as string)).rejects.toMatchObject({
      code: 'LOUSHO_WORKSPACE_ROOT_INVALID',
      status: 400,
    });
    expect(await registry.list()).toEqual([]);
  });

  it('add rejects a missing folder with LOUSHO_WORKSPACE_ROOT_MISSING', async () => {
    const missing = path.join(dir, 'no-such-folder');
    await expect(registry.add(missing)).rejects.toMatchObject({
      code: 'LOUSHO_WORKSPACE_ROOT_MISSING',
      status: 400,
    });
  });

  it('add rejects a file with LOUSHO_WORKSPACE_ROOT_NOT_DIR', async () => {
    const notADir = path.join(dir, 'notes.txt');
    fs.writeFileSync(notADir, 'hello');
    await expect(registry.add(notADir)).rejects.toMatchObject({
      code: 'LOUSHO_WORKSPACE_ROOT_NOT_DIR',
      status: 400,
    });
  });

  it('add rejects an already-registered folder (also spelled with a trailing separator)', async () => {
    const b = folder('beta');
    const ref = await registry.add(b);
    await expect(registry.add(b)).rejects.toBeInstanceOf(WorkspaceExistsError);
    await expect(registry.add(`${b}${path.sep}`)).rejects.toMatchObject({
      code: 'LOUSHO_WORKSPACE_EXISTS',
      existing: { id: ref.id },
    });
    expect(await registry.list()).toHaveLength(1);
  });

  it('remove drops the entry only (the folder is untouched) and returns false when absent', async () => {
    const b = folder('beta');
    const ref = await registry.add(b);
    expect(await registry.remove(ref.id)).toBe(true);
    expect(await registry.list()).toEqual([]);
    expect(fs.statSync(b).isDirectory()).toBe(true);
    expect(await registry.remove(ref.id)).toBe(false);
  });

  it('get returns the ref for a known id and undefined otherwise', async () => {
    const b = folder('beta');
    const ref = await registry.add(b);
    expect(await registry.get(ref.id)).toEqual(ref);
    expect(await registry.get('elsewhere-abc123')).toBeUndefined();
  });

  it('touch bumps lastOpenedAt and no-ops for an absent id', async () => {
    const b = folder('beta');
    const ref = await registry.add(b);
    tick += 5_000;
    await registry.touch(ref.id);
    expect((await registry.get(ref.id))?.lastOpenedAt).toBe(new Date(tick).toISOString());
    await expect(registry.touch('elsewhere-abc123')).resolves.toBeUndefined();
  });

  it('a corrupt file reads as [] with one console warning, and the next write replaces it', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await registry.list()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    const b = folder('beta');
    await registry.add(b);
    expect(await registry.list()).toHaveLength(1);
  });

  it('two parallel add() calls of different folders both land', async () => {
    const b = folder('beta');
    const c = folder('gamma');
    const [rb, rc] = await Promise.all([registry.add(b), registry.add(c)]);
    expect((await registry.list()).map((r) => r.id).sort()).toEqual([rb.id, rc.id].sort());
  });
});
