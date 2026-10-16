/**
 * R2: `fileStore(dir)`, an AgentStore of JSON files. Runs the shared store
 * contracts, then the file-specific behavior: layout, atomic claims of
 * approvals, id validation, a corrupt history file, and two agents on one dir.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { fileStore } from './fileStore';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { Message } from '../providers/llm';
import {
  describeApprovalStoreContract,
  describeCheckpointStoreContract,
  describeSessionStoreContract,
  makeCheckpoint,
  makePending,
  makeSnapshot,
} from './sqlite/__fixtures__/storeContracts';

// Real files: slow on a loaded Windows machine (antivirus scans every temp file).
vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-filestore-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describeSessionStoreContract('fileStore().sessions', () => fileStore(tempDir()).sessions);
describeCheckpointStoreContract('fileStore().checkpoints', () => fileStore(tempDir()).checkpoints);
describeApprovalStoreContract('fileStore().approvals', () => fileStore(tempDir()).approvals);

const save = (store: ReturnType<typeof fileStore>, sessionId: string, stepIndex: number) =>
  store.checkpoints.save(sessionId, makeCheckpoint({ sessionId, stepIndex }));

describe('fileStore(dir) (R2)', () => {
  it('writes sessions, checkpoints, history and approvals at the documented layout, with no temp or lock files left', async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    await store.sessions.save('chat', [{ role: 'user', content: 'hi' }]);
    await save(store, 'chat.turn-0', 1);
    const pending = makePending('appr_1');
    await store.approvals.save(pending, makeSnapshot(pending));

    expect(readdirSync(dir).sort()).toEqual(['approvals', 'checkpoint-history', 'checkpoints', 'sessions']);
    expect(readdirSync(join(dir, 'sessions'))).toEqual(['chat.json']);
    expect(readdirSync(join(dir, 'checkpoints'))).toEqual(['chat.turn-0.json']);
    expect(readdirSync(join(dir, 'checkpoint-history'))).toEqual(['chat.turn-0.json']);
    expect(readdirSync(join(dir, 'approvals'))).toEqual(['appr_1.json']);
  });

  it('round-trips a transcript with a Uint8Array file part, across store instances', async () => {
    const dir = tempDir();
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'read this' }, { type: 'file', data: bytes, mimeType: 'application/octet-stream' }] },
    ];
    await fileStore(dir).sessions.save('doc', messages);

    const loaded = await fileStore(dir).sessions.load('doc');
    const part = (loaded![0].content as Array<{ type: string; data?: unknown }>)[1];
    expect(part.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(part.data as Uint8Array)).toEqual(Array.from(bytes));
  });

  it('checkpoints: save, load, delete and history() newest first', async () => {
    const store = fileStore(tempDir());
    await save(store, 's', 1);
    await save(store, 's', 2);
    expect((await store.checkpoints.load('s'))?.stepIndex).toBe(2);
    expect((await store.checkpoints.history!('s')).map((entry) => entry.step)).toEqual([2, 1]);
    await store.checkpoints.delete('s');
    expect(await store.checkpoints.load('s')).toBeNull();
    expect(await store.checkpoints.history!('s')).toEqual([]);
  });

  it('honors historyLimit: 3 keeps the newest three, 0 keeps none, keepHistory keeps the ring', async () => {
    const small = fileStore(tempDir(), { historyLimit: 3 });
    for (let step = 0; step < 5; step++) await save(small, 's', step);
    expect((await small.checkpoints.history!('s')).map((entry) => entry.step)).toEqual([4, 3, 2]);
    await small.checkpoints.delete('s', { keepHistory: true });
    expect(await small.checkpoints.load('s')).toBeNull();
    expect((await small.checkpoints.history!('s')).map((entry) => entry.step)).toEqual([4, 3, 2]);

    const dir = tempDir();
    const off = fileStore(dir, { historyLimit: 0 });
    await save(off, 's', 1);
    expect(await off.checkpoints.history!('s')).toEqual([]);
    expect(readdirSync(dir)).not.toContain('checkpoint-history');
  });

  it('reads a truncated history file as empty, and the next save starts a new ring', async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    await save(store, 's', 1);
    writeFileSync(join(dir, 'checkpoint-history', 's.json'), '[{"step":1,"savedAt":"20');
    expect(await store.checkpoints.history!('s')).toEqual([]);
    await save(store, 's', 2);
    expect((await store.checkpoints.history!('s')).map((entry) => entry.step)).toEqual([2]);
  });

  it('approvals: resolve returns the record once, then null', async () => {
    const store = fileStore(tempDir());
    const pending = makePending('appr_once');
    await store.approvals.save(pending, makeSnapshot(pending));
    expect((await store.approvals.resolve('appr_once'))?.pending.id).toBe('appr_once');
    expect(await store.approvals.resolve('appr_once')).toBeNull();
  });

  it('two concurrent resolves of one approval (two store instances on one dir) give exactly one record', async () => {
    const dir = tempDir();
    for (let round = 0; round < 10; round++) {
      const id = `appr_race_${round}`;
      const pending = makePending(id);
      await fileStore(dir).approvals.save(pending, makeSnapshot(pending));
      const results = await Promise.all([fileStore(dir).approvals.resolve(id), fileStore(dir).approvals.resolve(id)]);
      expect(results.filter((result) => result !== null)).toHaveLength(1);
    }
    expect(readdirSync(join(dir, 'approvals'))).toEqual([]);
  });

  it('a claim left by a crashed resolver makes resolve return null until the approval is saved again', async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    const pending = makePending('appr_stale');
    await store.approvals.save(pending, makeSnapshot(pending));
    writeFileSync(join(dir, 'approvals', 'appr_stale.json.claim'), '1234');
    expect(await store.approvals.resolve('appr_stale')).toBeNull();
    await store.approvals.save(pending, makeSnapshot(pending));
    expect((await store.approvals.resolve('appr_stale'))?.pending.id).toBe('appr_stale');
  });

  it('a claim a crashed resolver left long ago is taken over, so the approval is not stuck forever', async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    const pending = makePending('appr_old');
    await store.approvals.save(pending, makeSnapshot(pending));
    const claim = join(dir, 'approvals', 'appr_old.json.claim');
    writeFileSync(claim, '1234');
    const old = new Date(Date.now() - 120_000);
    utimesSync(claim, old, old);
    const [first, second] = await Promise.all([store.approvals.resolve('appr_old'), fileStore(dir).approvals.resolve('appr_old')]);
    expect([first, second].filter(Boolean).map((record) => record?.pending.id)).toEqual(['appr_old']);
    expect(await store.approvals.resolve('appr_old')).toBeNull();
  });

  it('a corrupt checkpoint fails load() with LOUSHO_CHECKPOINT_CORRUPT and is listed as an in-progress run with that error', async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    await save(store, 'run-1', 1);
    writeFileSync(join(dir, 'checkpoints', 'run-1.json'), '{"agentId": "a", "mess');
    writeFileSync(join(dir, 'checkpoints', 'run-2.json'), '[]');
    await expect(store.checkpoints.load('run-1')).rejects.toMatchObject({ code: 'LOUSHO_CHECKPOINT_CORRUPT' });
    await expect(store.checkpoints.load('run-2')).rejects.toMatchObject({ code: 'LOUSHO_CHECKPOINT_CORRUPT' });
    const listed = await store.checkpoints.list!({ status: 'in-progress' });
    expect(listed.map((entry) => [entry.sessionId, entry.checkpoint.lastError?.code, entry.checkpoint.lastError?.retryable])).toEqual([
      ['run-1', 'LOUSHO_CHECKPOINT_CORRUPT', false],
      ['run-2', 'LOUSHO_CHECKPOINT_CORRUPT', false],
    ]);
    await store.checkpoints.delete('run-1');
    expect(await store.checkpoints.load('run-1')).toBeNull();
  });

  it('stores ids that would make a bad file name (too long once case-safe, a Windows device name) under a hashed name', async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    const long = 'X'.repeat(128);
    await store.sessions.save(long, [{ role: 'user', content: 'hi' }]);
    expect(await store.sessions.load(long)).toEqual([{ role: 'user', content: 'hi' }]);
    for (const id of [`${long}.turn-4`, 'nul', 'com1.turn-0']) await save(store, id, 3);
    expect((await store.checkpoints.list!()).map((entry) => entry.sessionId).sort()).toEqual(['com1.turn-0', 'nul', `${long}.turn-4`].sort());
    expect((await store.checkpoints.load('nul'))?.stepIndex).toBe(3);
    expect(readdirSync(join(dir, 'checkpoints')).some((name) => /^(nul|com1)\./i.test(name))).toBe(false);
  });

  it('a run lease held by a process that is gone from this host is taken over at once', async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    expect(await store.checkpoints.acquireLease!('run-1', '999999999:dead-run', 60_000)).toBe(true);
    expect(await fileStore(dir).checkpoints.acquireLease!('run-1', 'claim:other', 60_000)).toBe(true);
    expect(await fileStore(dir).checkpoints.acquireLease!('run-1', 'claim:third', 60_000)).toBe(false);
  });

  it('rejects session, checkpoint and approval ids that would escape the directory', async () => {
    const store = fileStore(tempDir());
    await expect(store.sessions.save('../evil', [])).rejects.toThrow(/Invalid session id/);
    await expect(store.sessions.load('a/../../b')).rejects.toThrow(/Invalid session id/);
    await expect(save(store, '../evil', 1)).rejects.toThrow(/Invalid session id/);
    await expect(store.checkpoints.load('..')).rejects.toThrow(/Invalid session id/);
    await expect(store.approvals.resolve('../evil')).rejects.toThrow(/Invalid approval id/);
    const pending = makePending('../evil');
    await expect(store.approvals.save(pending, makeSnapshot(pending))).rejects.toThrow(/Invalid approval id/);
  });

  it('approvals.load reads a malformed id as not found (only writes reject it)', async () => {
    const store = fileStore(tempDir());
    for (const id of ['bogus id!', '../evil', '', undefined as unknown as string]) {
      expect(await store.approvals.load!(id)).toBeNull();
    }
  });
});

describe('fileStore(dir): case-safe file names (Eve DUR-F7)', () => {
  const hi: Message[] = [{ role: 'user', content: 'hi' }];

  it("writes each uppercase letter as '^' and the letter, so an all-lowercase id keeps its old name", async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    await store.sessions.save('Alice', hi);
    await store.sessions.save('alice', hi);
    await save(store, 'Alice.turn-0', 1);
    const pending = makePending('Appr_1');
    await store.approvals.save(pending, makeSnapshot(pending));

    expect(readdirSync(join(dir, 'sessions')).sort()).toEqual(['^alice.json', 'alice.json']);
    expect(readdirSync(join(dir, 'checkpoints'))).toEqual(['^alice.turn-0.json']);
    expect(readdirSync(join(dir, 'checkpoint-history'))).toEqual(['^alice.turn-0.json']);
    expect(readdirSync(join(dir, 'approvals'))).toEqual(['^appr_1.json']);
  });

  it('reads a transcript, checkpoint and approval saved under the legacy mixed-case name, and moves it on the next save', async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    // Write files the way the store named them before the fix, then remove the case-safe copies.
    await store.sessions.save('Alice', hi);
    await save(store, 'Alice', 1);
    const pending = makePending('Appr_1');
    await store.approvals.save(pending, makeSnapshot(pending));
    for (const [sub, from, to] of [
      ['sessions', '^alice', 'Alice'],
      ['checkpoints', '^alice', 'Alice'],
      ['checkpoint-history', '^alice', 'Alice'],
      ['approvals', '^appr_1', 'Appr_1'],
    ]) {
      renameSync(join(dir, sub, `${from}.json`), join(dir, sub, `${to}.json`));
    }

    expect(await store.sessions.load('Alice')).toEqual(hi);
    expect((await store.checkpoints.load('Alice'))?.stepIndex).toBe(1);
    expect(await store.approvals.load!('Appr_1')).not.toBeNull();

    await store.sessions.save('Alice', [...hi, { role: 'assistant', content: 'hello' }]);
    await save(store, 'Alice', 2);
    expect(readdirSync(join(dir, 'sessions'))).toEqual(['^alice.json']);
    expect(readdirSync(join(dir, 'checkpoints'))).toEqual(['^alice.json']);
    expect(readdirSync(join(dir, 'checkpoint-history'))).toEqual(['^alice.json']);
    expect((await store.checkpoints.history!('Alice')).map((entry) => entry.step)).toEqual([2, 1]);

    expect((await store.approvals.resolve('Appr_1'))?.pending).toEqual(pending);
    expect(readdirSync(join(dir, 'approvals'))).toEqual([]);
  });

  it('reads files an earlier release wrote under a long case-safe name that is now shortened, and moves them on the next save', async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    // 91 uppercase letters: a 182-character case-safe name, written as it is before names were shortened past 180.
    const id = 'A'.repeat(91);
    const oldName = '^a'.repeat(91);
    const write = (sub: string, value: unknown) => {
      mkdirSync(join(dir, sub), { recursive: true });
      writeFileSync(join(dir, sub, `${oldName}.json`), JSON.stringify(value));
    };
    write('sessions', hi);
    write('checkpoints', makeCheckpoint({ sessionId: id, stepIndex: 1, status: 'awaiting-approval' }));
    write('checkpoint-history', [{ step: 1, savedAt: new Date().toISOString(), status: 'in-progress', checkpoint: makeCheckpoint({ sessionId: id, stepIndex: 1 }) }]);

    expect(await store.sessions.load(id)).toEqual(hi);
    expect((await store.checkpoints.load(id))?.stepIndex).toBe(1);
    expect((await store.checkpoints.history!(id)).map((entry) => entry.step)).toEqual([1]);
    expect((await store.checkpoints.list!()).map((entry) => entry.sessionId)).toEqual([id]);

    await store.sessions.save(id, [...hi, { role: 'assistant', content: 'hello' }]);
    await save(store, id, 2);
    for (const sub of ['sessions', 'checkpoints', 'checkpoint-history']) {
      const names = readdirSync(join(dir, sub));
      expect(names).toHaveLength(1);
      expect(names[0].startsWith('~')).toBe(true);
    }
    expect((await store.checkpoints.history!(id)).map((entry) => entry.step)).toEqual([2, 1]);
    expect((await store.sessions.load(id))?.length).toBe(2);
  });

  it("does not read a lowercase id's legacy file for a mixed-case id", async () => {
    const dir = tempDir();
    const store = fileStore(dir);
    await store.sessions.save('alice', hi); // 'alice.json': the same name before and after the fix
    expect(await store.sessions.load('Alice')).toBeUndefined();
    await store.sessions.delete('Alice');
    expect(await store.sessions.load('alice')).toEqual(hi);
  });
});

describe('fileStore(dir).prune()', () => {
  /** Backdates every file under `dir` whose name starts with one of `prefixes` by an hour. */
  const age = (dir: string, prefixes: string[]) => {
    const old = new Date(Date.now() - 60 * 60_000);
    for (const sub of ['sessions', 'checkpoints', 'checkpoint-history']) {
      for (const name of readdirSync(join(dir, sub))) if (prefixes.some((prefix) => name.startsWith(prefix))) utimesSync(join(dir, sub, name), old, old);
    }
  };

  it('deletes old transcripts, checkpoints and history files, but keeps recent ones and a run paused on a pending approval', async () => {
    const dir = tempDir();
    const tools = [defineTool({ name: 'deploy', description: 'deploy', input: z.object({}), needsApproval: true, execute: async () => 'deployed' })];
    const model = mockModel([(request) => (request.messages.at(-1)?.content === 'deploy' ? { toolCalls: [{ name: 'deploy', id: 'call_1' }] } : 'ok')], { onExhausted: 'repeat-last' });
    const store = fileStore(dir);
    const agent = createAgent({ provider: model, tools, store });
    await agent.session({ id: 'old' }).send('hi');
    await agent.session({ id: 'recent' }).send('hi');
    const paused = await agent.session({ id: 'waiting' }).send('deploy');
    expect(paused.finishReason).toBe('awaiting-approval');
    await agent.send('hi', { sessionId: 'old-run' });
    age(dir, ['old', 'waiting']);

    await expect(store.prune({ olderThanMs: -1 })).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
    // Eve3-S4: 'old' also leaves a turn-counter checkpoint and its history entry, pruned with it.
    expect(await store.prune({ olderThanMs: 60_000 })).toEqual({ sessions: 1, checkpoints: 2, checkpointHistory: 3, oauthPending: 0 });
    expect(readdirSync(join(dir, 'sessions'))).toEqual(['recent.json']);
    expect(readdirSync(join(dir, 'checkpoints')).filter((name) => name.startsWith('waiting')).sort()).toEqual(['waiting.paused.json', 'waiting.turn-0.json']);
    expect(readdirSync(join(dir, 'checkpoint-history')).some((name) => name.startsWith('old'))).toBe(false);
    expect(await store.checkpoints.load('old-run')).toBeNull();
    // The paused turn is intact and still resolves.
    const done = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(done.text).toBe('ok');
    // Once decided, the old paused-turn pointer is stale and goes.
    expect(await store.prune({ olderThanMs: 60_000 })).toEqual({ sessions: 0, checkpoints: 1, checkpointHistory: 1, oauthPending: 0 });
    expect(readdirSync(join(dir, 'sessions')).sort()).toEqual(['recent.json', 'waiting.json']);
  });
});

describe('createAgent({ store: fileStore(dir) }) (R2)', () => {
  it('a session survives a second createAgent() on the same dir', async () => {
    const dir = tempDir();
    await createAgent({ provider: mockModel(['Hi Ali.']), store: fileStore(dir) }).session({ id: 'chat' }).send('My name is Ali.');

    const model = mockModel(['Ali.']);
    const { text } = await createAgent({ provider: model, store: fileStore(dir) }).session({ id: 'chat' }).send('What is my name?');

    expect(text).toBe('Ali.');
    expect(model.calls[0].messages.some((m) => m.content === 'My name is Ali.')).toBe(true);
  });

  it('an approval-gated run paused on one agent resumes on a second agent over the same dir', async () => {
    const dir = tempDir();
    let sent = 0;
    const tools = [
      defineTool({ name: 'send_email', description: 'send', input: z.object({}), needsApproval: true, execute: async () => `sent ${++sent}` }),
    ];
    const paused = await createAgent({ provider: mockModel([{ toolCalls: [{ name: 'send_email', id: 'call_1' }] }]), tools, store: fileStore(dir) }).send(
      'Email Sam',
      { sessionId: 'job-1' }
    );
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(readdirSync(join(dir, 'approvals'))).toEqual([`${paused.approvalId}.json`]);

    const agent = createAgent({ provider: mockModel(['Email sent.']), tools, store: fileStore(dir) });
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(result.text).toBe('Email sent.');
    expect(sent).toBe(1);
    expect(await fileStore(dir).checkpoints.load('job-1')).toMatchObject({ status: 'finished' });
    expect(readdirSync(join(dir, 'approvals'))).toEqual([]);
  });

  it('agent.approvals.get() returns undefined for a malformed id', async () => {
    const agent = createAgent({ provider: mockModel(['Hi.']), store: fileStore(tempDir()) });
    expect(await agent.approvals.get('bogus id!')).toBeUndefined();
    expect(await agent.approvals.get('')).toBeUndefined();
  });
});
