import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgent } from '../../createAgent';
import { mockModel } from '../../testing';
import { createFsTools } from './fsTools';
import { NodeWorkspace } from './NodeWorkspace';
import { hashContent, WorkspaceCheckpoints, type WorkspaceFileBackup } from './checkpoints';
import { FileWorkspaceCheckpointStore } from './checkpointFileStore';

const IS_WINDOWS = process.platform === 'win32';

let tmp: string;
let rootDir: string;
let outsideDir: string;
let storeDir: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-rewind-')));
  rootDir = path.join(tmp, 'root');
  outsideDir = path.join(tmp, 'outside');
  storeDir = path.join(tmp, 'store');
  fs.mkdirSync(rootDir);
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP SECRET');
  fs.writeFileSync(path.join(rootDir, 'a.txt'), 'a0\n');
  fs.writeFileSync(path.join(rootDir, 'b.txt'), 'b0\n');
});

afterEach(() => {
  // Windows keeps a just-closed file or directory locked for a moment (EPERM / EBUSY); rmSync retries those.
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const read = (rel: string) => fs.readFileSync(path.join(rootDir, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(rootDir, rel));
const ctx = (sessionId: string) => ({ toolCallId: 'c', sessionId, messages: [{ role: 'user' as const, content: 'x' }] });

function backup(overrides: Partial<WorkspaceFileBackup>): WorkspaceFileBackup {
  return { sessionId: 's', turn: 0, toolCallId: 'c', path: 'a.txt', before: 'a0\n', afterHash: hashContent('a1\n'), at: new Date().toISOString(), ...overrides };
}

describe('WorkspaceCheckpoints on NodeWorkspace (N7)', () => {
  // Three agent turns, a cold createAgent import and real file I/O: well under a second alone, but past the 5s default when the machine is saturated (#326).
  it('rewinds three turns on disk, with a file store', async () => {
    const workspace = new NodeWorkspace({ root: rootDir });
    const checkpoints = new WorkspaceCheckpoints(workspace, { store: new FileWorkspaceCheckpointStore(storeDir) });
    const agent = createAgent({
      instructions: 'Edit files.',
      provider: mockModel([
        { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: 'a0', new_string: 'a1' } }] },
        'ok',
        { toolCalls: [{ name: 'write_file', args: { path: 'b.txt', content: 'b1\n' } }, { name: 'write_file', args: { path: 'new/c.txt', content: 'c1\n' } }] },
        'ok',
        { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: 'a1', new_string: 'a2' } }] },
        'ok',
      ]),
      tools: createFsTools(workspace, { checkpoints }),
    });
    const session = agent.session();
    for (const input of ['one', 'two', 'three']) await session.send(input);
    expect([read('a.txt'), read('b.txt'), read('new/c.txt')]).toEqual(['a2\n', 'b1\n', 'c1\n']);

    const dry = await checkpoints.rewind(1, { sessionId: session.id, dryRun: true });
    expect(dry).toEqual({ dryRun: true, restored: ['a.txt', 'b.txt'], deleted: ['new/c.txt'], skipped: [] });
    expect([read('a.txt'), read('b.txt'), read('new/c.txt')]).toEqual(['a2\n', 'b1\n', 'c1\n']);

    // A new instance over the same store directory sees the same backups (as after a restart).
    const reopened = new WorkspaceCheckpoints(workspace, { store: new FileWorkspaceCheckpointStore(storeDir) });
    expect(await reopened.rewind(1, { sessionId: session.id })).toEqual({ ...dry, dryRun: false });
    expect([read('a.txt'), read('b.txt'), exists('new/c.txt')]).toEqual(['a1\n', 'b0\n', false]);
    expect(await reopened.list({ sessionId: session.id })).toEqual([{ turn: 0, paths: ['a.txt'] }]);
  }, 30_000);

  it('never writes outside the root: a tampered store path is refused before anything changes', async () => {
    const workspace = new NodeWorkspace({ root: rootDir });
    const store = new FileWorkspaceCheckpointStore(storeDir);
    const checkpoints = new WorkspaceCheckpoints(workspace, { store });
    const [, writeFile] = createFsTools(workspace, { checkpoints });
    await writeFile.tool.execute!({ path: 'a.txt', content: 'a1\n' }, ctx('s'));
    await store.append(backup({ path: '../outside/secret.txt', before: 'pwned', afterHash: hashContent('TOP SECRET') }));
    await expect(checkpoints.rewind(0, { sessionId: 's', force: true })).rejects.toThrow(/invalid path/);
    expect(fs.readFileSync(path.join(outsideDir, 'secret.txt'), 'utf8')).toBe('TOP SECRET');
    expect(read('a.txt')).toBe('a1\n');
  });

  it('never writes outside the root through a link created after the backup', async () => {
    const workspace = new NodeWorkspace({ root: rootDir });
    const store = new FileWorkspaceCheckpointStore(storeDir);
    const checkpoints = new WorkspaceCheckpoints(workspace, { store });
    const [, writeFile] = createFsTools(workspace, { checkpoints });
    await writeFile.tool.execute!({ path: 'a.txt', content: 'a1\n' }, ctx('s'));
    // A junction needs no privilege on Windows; elsewhere a directory symlink.
    fs.symlinkSync(outsideDir, path.join(rootDir, 'link'), IS_WINDOWS ? 'junction' : 'dir');
    await store.append(backup({ path: 'link/secret.txt', before: 'pwned', afterHash: hashContent('TOP SECRET') }));
    await expect(checkpoints.rewind(0, { sessionId: 's', force: true })).rejects.toThrow(/outside the workspace/);
    await expect(checkpoints.rewind(0, { sessionId: 's', dryRun: true })).rejects.toThrow(/outside the workspace/);
    expect(fs.readFileSync(path.join(outsideDir, 'secret.txt'), 'utf8')).toBe('TOP SECRET');
    expect(read('a.txt')).toBe('a1\n');
  });

  it.skipIf(IS_WINDOWS)('restores the permission bits with the content', async () => {
    fs.writeFileSync(path.join(rootDir, 'run.sh'), 'echo 0\n', { mode: 0o755 });
    fs.chmodSync(path.join(rootDir, 'run.sh'), 0o755);
    const workspace = new NodeWorkspace({ root: rootDir });
    const checkpoints = new WorkspaceCheckpoints(workspace);
    const [, writeFile] = createFsTools(workspace, { checkpoints });
    await writeFile.tool.execute!({ path: 'run.sh', content: 'echo 1\n' }, ctx('s'));
    fs.chmodSync(path.join(rootDir, 'run.sh'), 0o600);
    expect((await checkpoints.rewind(0, { sessionId: 's' })).restored).toEqual(['run.sh']);
    expect(read('run.sh')).toBe('echo 0\n');
    expect(fs.statSync(path.join(rootDir, 'run.sh')).mode & 0o777).toBe(0o755);
  });

  it('NodeWorkspace.getMode / chmod stay inside the root', async () => {
    const workspace = new NodeWorkspace({ root: rootDir });
    expect(await workspace.getMode('missing.txt')).toBeUndefined();
    expect(typeof (await workspace.getMode('a.txt'))).toBe('number');
    await workspace.chmod('a.txt', 0o644);
    await expect(workspace.getMode('../outside/secret.txt')).rejects.toThrow(/outside the workspace/);
    await expect(workspace.chmod('../outside/secret.txt', 0o777)).rejects.toThrow(/outside the workspace/);
    await expect(workspace.chmod('missing.txt', 0o644)).rejects.toThrow(/File not found/);
  });
});

describe('FileWorkspaceCheckpointStore (N7)', () => {
  it('round-trips backups across instances and prunes by turn', async () => {
    const store = new FileWorkspaceCheckpointStore(storeDir);
    expect(await store.list('s')).toEqual([]);
    expect(await store.earliestTurn('s')).toBe(0);
    await Promise.all([0, 1, 2, 3].map((turn) => store.append(backup({ turn, path: `f${turn}.txt` }))));
    const again = new FileWorkspaceCheckpointStore(storeDir);
    expect((await again.list('s')).map((b) => b.turn).sort()).toEqual([0, 1, 2, 3]);

    await again.removeBeforeTurn('s', 1);
    expect(await again.earliestTurn('s')).toBe(1);
    await again.removeFromTurn('s', 3);
    expect((await store.list('s')).map((b) => b.turn).sort()).toEqual([1, 2]);
    expect(fs.readdirSync(storeDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    await again.removeFromTurn('s', 0);
    expect(fs.readdirSync(storeDir)).toEqual([]);
    expect(await again.earliestTurn('s')).toBe(0);
  });

  it('hashes session ids that are not plain file names', async () => {
    const store = new FileWorkspaceCheckpointStore(storeDir);
    await store.append(backup({ sessionId: '../a b/c' }));
    await store.append(backup({ sessionId: 'plain-id.turn' }));
    const files = fs.readdirSync(storeDir).sort();
    expect(files).toHaveLength(2);
    expect(files.every((f) => /^(h-[0-9a-f]{40}|s-plain-id\.turn)\.json$/.test(f))).toBe(true);
    expect(await store.list('../a b/c')).toHaveLength(1);
  });

  it('rejects a corrupt file and a missing directory', async () => {
    fs.mkdirSync(storeDir);
    fs.writeFileSync(path.join(storeDir, 's-s.json'), '{"nope":1}');
    await expect(new FileWorkspaceCheckpointStore(storeDir).list('s')).rejects.toThrow(/corrupt/);
    expect(() => new FileWorkspaceCheckpointStore('')).toThrow(/'dir' is required/);
  });
});
