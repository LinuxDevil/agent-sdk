/**
 * Run leases: a checkpointed run (a session turn, a `send(msg, { sessionId })`
 * run) holds a lease on its checkpoint id while it runs, so a second process -
 * here a second store object over the same files or database - is refused with
 * `LOUSHO_SESSION_BUSY` before it runs anything, instead of re-running the live
 * run's tool calls. Also: run ids cannot address a session's own checkpoint keys.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockRequest } from '../testing';
import { fileStore } from '../storage/fileStore';
import { memoryStore } from '../storage/agentStore';
import { SqliteStore } from '../storage/sqlite';
import type { AgentStore } from '../storage/agentStore';

const dirs: string[] = [];
const sqlite: SqliteStore[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-lease-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const store of sqlite.splice(0)) store.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const replyTo = (name: string) => (request: MockRequest) =>
  request.messages.at(-1)?.role === 'tool'
    ? `${name} done`
    : request.messages.at(-1)?.content === 'charge me'
      ? { toolCalls: [{ name: 'charge', id: 'call_A', args: { amount: 100 } }] }
      : `${name} hello`;

/** Two "processes": each its own store object over the same data. */
const backends: Array<[string, () => () => AgentStore]> = [
  ['fileStore', () => {
    const dir = tempDir();
    return () => fileStore(dir);
  }],
  ['SqliteStore', () => {
    const file = join(tempDir(), 'db.sqlite');
    return () => {
      const store = new SqliteStore(file);
      sqlite.push(store);
      return store;
    };
  }],
];

describe.each(backends)('run leases over %s', (_name, backend) => {
  it("a second process's send() is refused while the first one's turn runs, and nothing runs twice", async () => {
    const open = backend();
    const charges: string[] = [];
    let charging!: () => void;
    const started = new Promise<void>((resolve) => (charging = resolve));
    const charge = defineTool({
      name: 'charge',
      description: 'charge',
      input: z.object({ amount: z.number() }),
      execute: async (_args, ctx) => {
        charges.push(ctx.toolCallId);
        charging();
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { ok: true };
      },
    });
    const a = createAgent({ provider: mockModel([replyTo('A')], { onExhausted: 'repeat-last' }), tools: [charge], store: open() });
    const b = createAgent({ provider: mockModel([replyTo('B')], { onExhausted: 'repeat-last' }), tools: [charge], store: open() });

    const first = a.session({ id: 'u1' }).send('charge me');
    // Wait until the first turn is inside its tool call (lease held), not a fixed delay.
    await started;
    await expect(b.session({ id: 'u1' }).send('hello')).rejects.toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });
    expect((await first).text).toBe('A done');

    expect(charges).toEqual(['call_A']);
    const transcript = await a.session({ id: 'u1' }).load();
    expect(transcript.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    // Once the turn is over the second process takes turns again.
    expect((await b.session({ id: 'u1' }).send('hello')).text).toBe('B hello');
  });

  it('a send({ sessionId }) run is refused the same way while another process runs it', async () => {
    const open = backend();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let running!: () => void;
    const started = new Promise<void>((resolve) => (running = resolve));
    const slow = defineTool({ name: 'slow', description: 'slow', input: z.object({}), execute: async () => (running(), gate.then(() => 'ok')) });
    const model = () => mockModel([{ toolCalls: [{ name: 'slow', id: 'call_slow' }] }, 'done'], { onExhausted: 'repeat-last' });
    const a = createAgent({ provider: model(), tools: [slow], store: open() });
    const b = createAgent({ provider: model(), tools: [slow], store: open() });
    const run = a.send('go', { sessionId: 'job-1' });
    await started;
    await expect(b.resume('job-1')).rejects.toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });
    release();
    expect((await run).text).toBe('done');
  });
});

/** Two "processes" over the same data, and a way to make the lease on `id` look long expired (its holder stalled). */
const stallable: Array<[string, () => { open: () => AgentStore; stall: (id: string) => void }]> = [
  ['fileStore', () => {
    const dir = tempDir();
    return {
      open: () => fileStore(dir),
      stall: (id) => {
        const file = join(dir, 'leases', `${id}.json`);
        writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), expiresAt: Date.now() - 120_000 }));
      },
    };
  }],
  ['SqliteStore', () => {
    const file = join(tempDir(), 'db.sqlite');
    const open = () => {
      const store = new SqliteStore(file);
      sqlite.push(store);
      return store;
    };
    const admin = open();
    return { open, stall: (id) => void admin.connection.db.prepare('UPDATE leases SET expires_at = ? WHERE id = ?').run(Date.now() - 120_000, id) };
  }],
];

describe.each(stallable)('a run that stalled past its lease, over %s', (_name, backend) => {
  it('cannot overwrite the progress of the process that took over, even after that one released the lease', async () => {
    const { open, stall } = backend();
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let running!: () => void;
    const started = new Promise<void>((resolve) => (running = resolve));
    const work = (who: string) =>
      defineTool({
        name: 'work',
        description: 'work',
        input: z.object({}),
        execute: async () => {
          calls.push(who);
          if (who === 'A') {
            running();
            await gate;
          }
          return `by ${who}`;
        },
      });
    const model = (who: string) => mockModel([(request) => (request.messages.at(-1)?.role === 'tool' ? `done by ${who}` : { toolCalls: [{ name: 'work', id: 'call_1' }] })], { onExhausted: 'repeat-last' });
    const a = createAgent({ provider: model('A'), tools: [work('A')], store: open() });
    const bStore = open();
    const b = createAgent({ provider: model('B'), tools: [work('B')], store: bStore });

    const first = a.send('go', { sessionId: 'job-1' });
    await started;
    stall('job-1');
    expect((await b.resume('job-1'))?.text).toBe('done by B');
    release();
    await expect(first).rejects.toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });

    expect(calls).toEqual(['A', 'B']);
    const checkpoint = await bStore.checkpoints!.load('job-1');
    expect(checkpoint?.status).toBe('finished');
    expect(checkpoint?.messages.at(-1)?.content).toBe('done by B');
  });

  it("a session turn: its late result is not appended after the other process's turn", async () => {
    const { open, stall } = backend();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let running!: () => void;
    const started = new Promise<void>((resolve) => (running = resolve));
    const work = (who: string) =>
      defineTool({ name: 'work', description: 'work', input: z.object({}), execute: async () => (who === 'A' ? (running(), gate.then(() => 'by A')) : 'by B') });
    const model = (who: string) => mockModel([(request) => (request.messages.at(-1)?.role === 'tool' ? `done by ${who}` : { toolCalls: [{ name: 'work', id: 'call_1' }] })], { onExhausted: 'repeat-last' });
    const a = createAgent({ provider: model('A'), tools: [work('A')], store: open() });
    const b = createAgent({ provider: model('B'), tools: [work('B')], store: open() });

    const first = a.session({ id: 's1' }).send('go');
    await started;
    stall('s1.turn-0');
    expect((await b.session({ id: 's1' }).resume())?.text).toBe('done by B');
    release();
    await expect(first).rejects.toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });
    const transcript = await b.session({ id: 's1' }).load();
    expect(transcript.map((message) => `${message.role}:${typeof message.content === 'string' ? message.content : ''}`)).toEqual(['user:go', 'assistant:', 'tool:"by B"', 'assistant:done by B']);
  });
});

describe('run ids and session checkpoint keys', () => {
  it("agent.send() cannot write into a session's turn or paused-turn pointer", async () => {
    const store = memoryStore();
    const agent = createAgent({ provider: mockModel(['ok'], { onExhausted: 'repeat-last' }), store });
    await agent.session({ id: 'victim' }).send('my pin is 1234');
    for (const sessionId of ['victim.turn-2', 'victim.paused', 'schedule-daily-2026-10-10T030000Z.fire', '', '../x', 'café']) {
      await expect(agent.send('ATTACKER', { sessionId })).rejects.toMatchObject({ code: 'LOUSHO_SESSION_ID_INVALID' });
    }
    // A fork of a session turn is a run of its own and stays allowed.
    await expect(agent.send('hi', { sessionId: 'victim.turn-2.fork-1' })).resolves.toMatchObject({ finishReason: 'stop' });
    expect((await agent.session({ id: 'victim' }).load())[0]?.content).toBe('my pin is 1234');
  });

  it("agent.fork() refuses a session's paused-turn pointer and a fork id that names a session turn", async () => {
    const agent = createAgent({ provider: mockModel(['ok'], { onExhausted: 'repeat-last' }), store: memoryStore() });
    await agent.send('hi', { sessionId: 'job' });
    await expect(agent.fork('s1.paused', { fromStep: 1 })).rejects.toMatchObject({ code: 'LOUSHO_SESSION_ID_INVALID' });
    await expect(agent.fork('job', { fromStep: 1, newSessionId: 'victim.turn-0' })).rejects.toMatchObject({ code: 'LOUSHO_SESSION_ID_INVALID' });
  });
});

describe('unreadable checkpoints and transcripts', () => {
  it('a corrupt turn checkpoint fails send() with LOUSHO_CHECKPOINT_CORRUPT, is listed by pending(), and discardPending() recovers', async () => {
    const dir = tempDir();
    const agent = createAgent({ provider: mockModel(['ok'], { onExhausted: 'repeat-last' }), store: fileStore(dir) });
    const session = agent.session({ id: 's1' });
    await session.send('hello');
    writeFileSync(join(dir, 'checkpoints', 's1.turn-2.json'), '');

    await expect(session.send('again')).rejects.toMatchObject({ code: 'LOUSHO_CHECKPOINT_CORRUPT' });
    const [pending] = await agent.pending();
    expect(pending).toMatchObject({ sessionId: 's1', status: 'in-progress', lastError: { code: 'LOUSHO_CHECKPOINT_CORRUPT', retryable: false } });

    await session.discardPending();
    expect(await agent.pending()).toEqual([]);
    expect((await session.send('again')).text).toBe('ok');
  });

  it('clear() empties a session whose transcript file or turn checkpoint cannot be read', async () => {
    const dir = tempDir();
    const agent = createAgent({ provider: mockModel(['ok'], { onExhausted: 'repeat-last' }), store: fileStore(dir) });
    const session = agent.session({ id: 's1' });
    await session.send('hello');
    writeFileSync(join(dir, 'checkpoints', 's1.turn-2.json'), '{"mess');
    writeFileSync(join(dir, 'sessions', 's1.json'), '[{"role":');
    await expect(session.send('again')).rejects.toMatchObject({ code: 'LOUSHO_SESSION_FILE_CORRUPT' });

    await session.clear();
    expect(await session.load()).toEqual([]);
    expect(await agent.pending()).toEqual([]);
  });
});
