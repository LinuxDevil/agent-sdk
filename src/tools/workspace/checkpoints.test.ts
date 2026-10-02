import { describe, it, expect } from 'vitest';
import { createAgent } from '../../createAgent';
import { mockModel, type MockResponse } from '../../testing';
import { memoryStore } from '../../storage/agentStore';
import { createFsTools } from './fsTools';
import { MemoryWorkspace } from './MemoryWorkspace';
import { MemoryWorkspaceCheckpointStore, WorkspaceCheckpoints, type WorkspaceCheckpointsOptions } from './checkpoints';
import { WorkspaceError } from './paths';

type Call = { name: string; args: Record<string, unknown> };
const write = (path: string, content: string): Call => ({ name: 'write_file', args: { path, content } });
const edit = (path: string, old_string: string, new_string: string): Call => ({ name: 'edit_file', args: { path, old_string, new_string } });

/** One turn per entry: a step with these tool calls, then a final answer. */
function script(turns: Call[][]): MockResponse[] {
  return turns.flatMap((toolCalls, i) => [{ toolCalls }, `turn ${i} done`]);
}

function setup(turns: Call[][], files: Record<string, string>, options: WorkspaceCheckpointsOptions = {}) {
  const workspace = new MemoryWorkspace({ files });
  const checkpoints = new WorkspaceCheckpoints(workspace, options);
  const agent = createAgent({
    instructions: 'Edit files.',
    provider: mockModel(script(turns)),
    tools: createFsTools(workspace, { checkpoints }),
  });
  return { workspace, checkpoints, agent };
}

/** Three turns that create, edit and overwrite files. */
const THREE_TURNS: Call[][] = [
  [edit('a.txt', 'a0', 'a1'), write('c.txt', 'c0\n')],
  [write('b.txt', 'b1\n'), write('d.txt', 'd1\n'), edit('a.txt', 'a1', 'a2')],
  [edit('c.txt', 'c0', 'c2'), write('e/f.txt', 'f2\n'), write('b.txt', 'b2\n')],
];
const START = { 'a.txt': 'a0\n', 'b.txt': 'b0\n' };

async function runThreeTurns(options: WorkspaceCheckpointsOptions = {}) {
  const ctx = setup(THREE_TURNS, START, options);
  const session = ctx.agent.session();
  for (const input of ['one', 'two', 'three']) await session.send(input);
  return { ...ctx, sessionId: session.id };
}

describe('WorkspaceCheckpoints through createAgent().session() (N7)', () => {
  it('lists the changed paths per turn', async () => {
    const { checkpoints, sessionId, workspace } = await runThreeTurns();
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a2\n', 'b.txt': 'b2\n', 'c.txt': 'c2\n', 'd.txt': 'd1\n', 'e/f.txt': 'f2\n' });
    expect(await checkpoints.list({ sessionId })).toEqual([
      { turn: 0, paths: ['a.txt', 'c.txt'] },
      { turn: 1, paths: ['a.txt', 'b.txt', 'd.txt'] },
      { turn: 2, paths: ['b.txt', 'c.txt', 'e/f.txt'] },
    ]);
  });

  it('a dry run reports and changes nothing; the real rewind restores turn-0 content and deletes created files', async () => {
    const { checkpoints, sessionId, workspace } = await runThreeTurns();
    const before = workspace.snapshot();
    const dry = await checkpoints.rewind(1, { sessionId, dryRun: true });
    expect(dry).toEqual({ dryRun: true, restored: ['a.txt', 'b.txt', 'c.txt'], deleted: ['d.txt', 'e/f.txt'], skipped: [] });
    expect(workspace.snapshot()).toEqual(before);
    expect((await checkpoints.list({ sessionId })).map((t) => t.turn)).toEqual([0, 1, 2]);

    const real = await checkpoints.rewind(1, { sessionId });
    expect(real).toEqual({ ...dry, dryRun: false });
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a1\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' });
    expect(await checkpoints.list({ sessionId })).toEqual([{ turn: 0, paths: ['a.txt', 'c.txt'] }]);

    // A second rewind finds nothing left to do.
    expect(await checkpoints.rewind(1, { sessionId })).toEqual({ dryRun: false, restored: [], deleted: [], skipped: [] });
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a1\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' });

    await checkpoints.rewind(0, { sessionId });
    expect(workspace.snapshot()).toEqual(START);
  });

  it("skips a file changed by something else as 'changed-since', unless force", async () => {
    const { checkpoints, sessionId, workspace } = await runThreeTurns();
    await workspace.writeFile('b.txt', 'edited by the user\n');
    await workspace.rm('d.txt');
    const dry = await checkpoints.rewind(1, { sessionId, dryRun: true });
    expect(dry.skipped).toEqual([{ path: 'b.txt', reason: 'changed-since' }]);
    // d.txt was created by the agent and is already gone: nothing to do.
    expect(dry.deleted).toEqual(['e/f.txt']);

    const forced = await checkpoints.rewind(1, { sessionId, force: true });
    expect(forced.restored).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a1\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' });
  });

  it("does not back up files over maxFileBytes; rewind skips them as 'too-large' and never deletes them", async () => {
    const big = 'x'.repeat(50);
    const { workspace, checkpoints, agent } = setup([[write('big.txt', 'small\n'), write('new.txt', 'y'.repeat(60))]], { 'big.txt': big }, { maxFileBytes: 20 });
    const session = agent.session();
    await session.send('go');
    const result = await checkpoints.rewind(0, { sessionId: session.id });
    expect(result.skipped).toEqual([{ path: 'big.txt', reason: 'too-large' }]);
    expect(result.deleted).toEqual(['new.txt']);
    expect(workspace.snapshot()).toEqual({ 'big.txt': 'small\n' });
  });

  it("skips a path that is now a directory as 'not-a-file'", async () => {
    const { workspace, checkpoints, agent } = setup([[write('x', 'file\n')]], {});
    const session = agent.session();
    await session.send('go');
    await workspace.rm('x');
    await workspace.mkdir('x');
    expect((await checkpoints.rewind(0, { sessionId: session.id, force: true })).skipped).toEqual([{ path: 'x', reason: 'not-a-file' }]);
  });

  it('separate sessions do not affect each other', async () => {
    const workspace = new MemoryWorkspace({ files: { 'shared.txt': 's0\n' } });
    const checkpoints = new WorkspaceCheckpoints(workspace);
    const agent = createAgent({
      instructions: 'Edit files.',
      provider: mockModel(script([[write('one.txt', '1\n')], [write('two.txt', '2\n')]])),
      tools: createFsTools(workspace, { checkpoints }),
    });
    const first = agent.session();
    const second = agent.session();
    await first.send('one');
    await second.send('two');
    expect(await checkpoints.rewind(0, { sessionId: first.id })).toEqual({ dryRun: false, restored: [], deleted: ['one.txt'], skipped: [] });
    expect(workspace.snapshot()).toEqual({ 'shared.txt': 's0\n', 'two.txt': '2\n' });
    expect(await checkpoints.list({ sessionId: second.id })).toEqual([{ turn: 0, paths: ['two.txt'] }]);
  });

  it('a checkpointed session (turns run as <id>.turn-<n>) is grouped under the session id', async () => {
    const workspace = new MemoryWorkspace({ files: { 'a.txt': 'a0\n' } });
    const checkpoints = new WorkspaceCheckpoints(workspace);
    const agent = createAgent({
      instructions: 'Edit files.',
      provider: mockModel(script([[write('a.txt', 'a1\n')], [write('a.txt', 'a2\n')]])),
      tools: createFsTools(workspace, { checkpoints }),
      store: memoryStore(),
    });
    const session = agent.session({ id: 'chat-1' });
    await session.send('one');
    await session.send('two');
    expect(await checkpoints.list({ sessionId: 'chat-1' })).toEqual([
      { turn: 0, paths: ['a.txt'] },
      { turn: 1, paths: ['a.txt'] },
    ]);
    await checkpoints.rewind(1, { sessionId: 'chat-1' });
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a1\n' });
  });

  it("agent.send() without a session records every call as turn 0 of 'default'", async () => {
    const { workspace, checkpoints, agent } = setup([[write('a.txt', 'a1\n')], [write('b.txt', 'b1\n')]], { 'a.txt': 'a0\n' });
    await agent.send('one');
    await agent.send('two');
    expect(await checkpoints.list()).toEqual([{ turn: 0, paths: ['a.txt', 'b.txt'] }]);
    await checkpoints.rewind(0);
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a0\n' });
  });

  it('records nothing for a failed edit', async () => {
    const { checkpoints, agent, workspace } = setup([[edit('a.txt', 'missing', 'x'), edit('nope.txt', 'a', 'b')]], { 'a.txt': 'a0\n' });
    const session = agent.session();
    await session.send('go');
    expect(await checkpoints.list({ sessionId: session.id })).toEqual([]);
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a0\n' });
  });

  it('records every write; repeats in one turn keep only a hash, and rewind uses the turn\'s first backup', async () => {
    const store = new MemoryWorkspaceCheckpointStore();
    const { checkpoints, agent, workspace } = setup(
      [[write('a.txt', 'a1\n'), write('a.txt', 'a2\n'), edit('a.txt', 'a2', 'a3')]],
      { 'a.txt': 'a0\n' },
      { store }
    );
    const session = agent.session();
    await session.send('go');
    const backups = await store.list(session.id);
    expect(backups).toHaveLength(3);
    expect(backups.filter((b) => b.before === 'a0\n')).toHaveLength(1);
    expect(backups.filter((b) => b.omitted === 'same-turn' && b.before === null)).toHaveLength(2);
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a3\n' });
    await checkpoints.rewind(0, { sessionId: session.id });
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a0\n' });
  });

  it('keeps the newest maxTurns turns; an older turn cannot be rewound', async () => {
    const { checkpoints, sessionId, workspace } = await runThreeTurns({ maxTurns: 2 });
    expect((await checkpoints.list({ sessionId })).map((t) => t.turn)).toEqual([1, 2]);
    await expect(checkpoints.rewind(0, { sessionId })).rejects.toThrow(/turns before 1 .* are no longer kept/);
    await checkpoints.rewind(1, { sessionId });
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a1\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' });
  });

  it('clear() forgets a session', async () => {
    const { checkpoints, sessionId } = await runThreeTurns();
    await checkpoints.clear({ sessionId });
    expect(await checkpoints.list({ sessionId })).toEqual([]);
  });
});

describe('WorkspaceCheckpoints details (N7)', () => {
  /** A MemoryWorkspace with permission bits, like NodeWorkspace on Linux. */
  class ModeWorkspace extends MemoryWorkspace {
    readonly modes = new Map<string, number>();
    async getMode(path: string): Promise<number | undefined> {
      return (await this.stat(path)) ? (this.modes.get(path) ?? 0o644) : undefined;
    }
    async chmod(path: string, mode: number): Promise<void> {
      this.modes.set(path, mode);
    }
  }

  const ctx = (sessionId: string, users: number) => ({
    toolCallId: 'c',
    sessionId,
    messages: Array.from({ length: users }, () => ({ role: 'user' as const, content: 'x' })),
  });

  it('restores the mode of a file deleted outside the agent (force)', async () => {
    const workspace = new ModeWorkspace({ files: { 'run.sh': 'echo 0\n' } });
    workspace.modes.set('run.sh', 0o755);
    const checkpoints = new WorkspaceCheckpoints(workspace);
    const [, writeFile] = createFsTools(workspace, { checkpoints });
    await writeFile.tool.execute!({ path: 'run.sh', content: 'echo 1\n' }, ctx('s', 1));
    await workspace.rm('run.sh');
    workspace.modes.delete('run.sh');
    expect(await checkpoints.rewind(0, { sessionId: 's', force: true })).toMatchObject({ restored: ['run.sh'] });
    expect(workspace.snapshot()).toEqual({ 'run.sh': 'echo 0\n' });
    expect(workspace.modes.get('run.sh')).toBe(0o755);
  });

  it('serializes concurrent writes to one path', async () => {
    const workspace = new MemoryWorkspace({ files: { 'a.txt': 'a0\n' } });
    const checkpoints = new WorkspaceCheckpoints(workspace);
    const [, writeFile] = createFsTools(workspace, { checkpoints });
    await Promise.all(['1', '2', '3'].map((n) => writeFile.tool.execute!({ path: 'a.txt', content: `a${n}\n` }, ctx('s', 1))));
    await checkpoints.rewind(0, { sessionId: 's' });
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a0\n' });
  });

  it('refuses a stored path that escapes the workspace, before changing anything', async () => {
    const workspace = new MemoryWorkspace({ files: { 'a.txt': 'a0\n' } });
    const store = new MemoryWorkspaceCheckpointStore();
    const checkpoints = new WorkspaceCheckpoints(workspace, { store });
    const [, writeFile] = createFsTools(workspace, { checkpoints });
    await writeFile.tool.execute!({ path: 'a.txt', content: 'a1\n' }, ctx('s', 1));
    const [backup] = await store.list('s');
    await store.append({ ...backup, path: '../outside.txt' });
    await expect(checkpoints.rewind(0, { sessionId: 's' })).rejects.toThrow(WorkspaceError);
    await expect(checkpoints.rewind(0, { sessionId: 's', dryRun: true })).rejects.toThrow(/invalid path/);
    expect(workspace.snapshot()).toEqual({ 'a.txt': 'a1\n' });
  });

  it('validates its options and arguments', async () => {
    const workspace = new MemoryWorkspace();
    expect(() => new WorkspaceCheckpoints(workspace, { maxFileBytes: 0 })).toThrow(/maxFileBytes/);
    expect(() => new WorkspaceCheckpoints(workspace, { maxTurns: 1.5 })).toThrow(/maxTurns/);
    expect(() => new WorkspaceCheckpoints(workspace, { maxTurns: Infinity })).not.toThrow();
    await expect(new WorkspaceCheckpoints(workspace).rewind(-1)).rejects.toThrow(/non-negative integer/);
  });

  it('reports a failed restore with what was already rewound, and keeps the backups', async () => {
    const workspace = new MemoryWorkspace({ files: { 'a.txt': 'a0\n', 'b.txt': 'b0\n' } });
    const checkpoints = new WorkspaceCheckpoints(workspace);
    const [, writeFile] = createFsTools(workspace, { checkpoints });
    await writeFile.tool.execute!({ path: 'a.txt', content: 'a1\n' }, ctx('s', 1));
    await writeFile.tool.execute!({ path: 'b.txt', content: 'b1\n' }, ctx('s', 1));
    const original = workspace.writeFile.bind(workspace);
    workspace.writeFile = async (path, content) => (path === 'b.txt' ? Promise.reject(new Error('disk full')) : original(path, content));
    await expect(checkpoints.rewind(0, { sessionId: 's' })).rejects.toThrow(/rewind stopped at b\.txt: disk full Already rewound: a\.txt/);
    expect(await checkpoints.list({ sessionId: 's' })).toEqual([{ turn: 0, paths: ['a.txt', 'b.txt'] }]);
  });
});
