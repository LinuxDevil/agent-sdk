/**
 * N3a: `session.history()` and `session.fork({ fromStep })` on agent sessions,
 * offline with mockModel.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { SessionAwaitingApprovalError, type SDKError } from '../execution/errors';
import { memoryStore } from '../storage/agentStore';
import { mockModel, type MockRequest, type MockTurn } from '../testing';
import { AgentSession, FileSessionStore, MemorySessionStore } from './index';
import { transcriptSteps } from './sessionFork';
import type { Message } from '../providers/llm';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const lookup = defineTool({
  name: 'lookup',
  description: 'look up',
  input: z.object({ q: z.string() }),
  execute: async ({ q }) => `result for ${q}`,
});

let approvedRuns = 0;
const sendEmail = defineTool({
  name: 'send_email',
  description: 'send an email',
  input: z.object({}),
  needsApproval: true,
  execute: async () => {
    approvedRuns++;
    return 'sent';
  },
});

const convo = (call: Pick<MockRequest, 'messages'> | undefined): string[] =>
  (call?.messages ?? []).filter((m) => m.role !== 'system').map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : ''}`);
const lookupTurn: MockTurn = { toolCalls: [{ name: 'lookup', id: 'c1', args: { q: 'x' } }] };

/** A two-turn session: turn 0 calls `lookup` then answers, turn 1 answers. `extra` scripts later calls. */
async function twoTurns(extra: MockTurn[] = [], options: Parameters<ReturnType<typeof createAgent>['session']>[0] = {}) {
  const model = mockModel([lookupTurn, 'It is x.', 'Bye.', ...extra]);
  const agent = createAgent({ provider: model, tools: [lookup, sendEmail] });
  const session = agent.session({ id: 'chat', ...options });
  await session.send('find x');
  await session.send('thanks');
  return { model, agent, session };
}

async function rejection(promise: Promise<unknown>): Promise<SDKError & { field?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as SDKError & { field?: string };
  }
  throw new Error('expected a rejection');
}

describe('session.history()', () => {
  it('lists the steps of a two-turn session with a tool call', async () => {
    const { session } = await twoTurns();
    const steps = await session.history();
    expect(steps).toEqual([
      { step: 1, turn: 0, messageIndex: 1, text: '', toolCalls: [{ id: 'c1', name: 'lookup', args: { q: 'x' }, result: '"result for x"' }] },
      { step: 2, turn: 0, messageIndex: 3, text: 'It is x.', toolCalls: [] },
      { step: 3, turn: 1, messageIndex: 5, text: 'Bye.', toolCalls: [] },
    ]);
    expect(session.messages[steps[0].messageIndex].role).toBe('assistant');
  });

  it('returns copies that cannot change the session', async () => {
    const { session } = await twoTurns();
    const steps = await session.history();
    (steps[0].toolCalls[0].args as { q: string }).q = 'tampered';
    expect((await session.history())[0].toolCalls[0].args).toEqual({ q: 'x' });
  });

  it('loads a session continued from its store, and is empty for a new one', async () => {
    const store = new MemorySessionStore();
    const agent = createAgent({ provider: mockModel(['hello']) });
    await agent.session({ id: 'saved', store }).send('hi');
    expect((await agent.session({ id: 'saved', store }).history()).map((s) => s.text)).toEqual(['hello']);
    expect(await agent.session().history()).toEqual([]);
  });

  it("counts input queued into a running turn (turnPolicy: 'queue') as a new turn", async () => {
    let entered!: () => void;
    let release!: () => void;
    const inTool = new Promise<void>((resolve) => (entered = resolve));
    const gate = defineTool({
      name: 'lookup',
      description: 'look up',
      input: z.object({ q: z.string() }),
      execute: async () => {
        entered();
        await new Promise<void>((resolve) => (release = resolve));
        return 'found';
      },
    });
    const model = mockModel([lookupTurn, 'Both done.']);
    const session = createAgent({ provider: model, tools: [gate] }).session({ turnPolicy: 'queue' });
    const first = session.send('find x');
    await inTool; // the turn is running its tool: input queued now joins before its next model call
    const queued = session.send('and y');
    release();
    expect((await queued).text).toBe((await first).text);
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
    expect((await session.history()).map(({ step, turn }) => [step, turn])).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it('starts a turn at every user message, queued input too; content parts and bad JSON arguments are kept readable', () => {
    const messages: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{not json' } }] },
      { role: 'tool', content: [{ type: 'text', text: 'out' }], toolCallId: 't1' },
      { role: 'user', content: 'queued' },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    expect(transcriptSteps(messages).map(({ step, end }) => ({ ...step, end }))).toEqual([
      { step: 1, turn: 1, messageIndex: 2, text: '', toolCalls: [{ id: 't1', name: 'f', args: '{not json', result: 'out' }], end: 4 },
      { step: 2, turn: 2, messageIndex: 5, text: 'done', toolCalls: [], end: 6 },
    ]);
  });
});

describe('session.fork()', () => {
  it('keeps only the steps up to fromStep; the fork and the original each continue their own transcript', async () => {
    const { model, session } = await twoTurns(['fork answer', 'original answer']);
    const fork = await session.fork({ fromStep: 1 });

    expect(fork).toBeInstanceOf(AgentSession);
    expect(fork.id).toBe('chat-fork-1');
    await fork.send('and y?');
    expect(convo(model.calls[3])).toEqual(['user:find x', 'assistant:', 'tool:"result for x"', 'user:and y?']);

    await session.send('again');
    expect(convo(model.calls[4])).toEqual(['user:find x', 'assistant:', 'tool:"result for x"', 'assistant:It is x.', 'user:thanks', 'assistant:Bye.', 'user:again']);
    expect((await fork.history()).map((s) => s.text)).toEqual(['', 'fork answer']);
  });

  it('keeps nothing with fromStep 0', async () => {
    const { model, session } = await twoTurns(['fresh']);
    const fork = await session.fork({ fromStep: 0 });
    expect(await fork.load()).toEqual([]);
    await fork.send('hello');
    expect(convo(model.calls[3])).toEqual(['user:hello']);
  });

  it('rejects a step outside 0..history().length, listing the range', async () => {
    const { session } = await twoTurns();
    for (const fromStep of [4, -1, 1.5]) {
      const error = await rejection(session.fork({ fromStep }));
      expect(error.code).toBe('LOUSHO_SESSION_STEP_NOT_FOUND');
      expect(error.name).toBe('ConfigurationError');
      expect(error.field).toBe('fromStep');
      expect(error.message).toContain('from 0 to 3');
    }
  });

  it('rejects an id that has a transcript, or is its own', async () => {
    const store = new MemorySessionStore();
    await store.save('taken', [{ role: 'user', content: 'mine' }]);
    const { session } = await twoTurns([], { store });
    for (const id of ['taken', 'chat']) {
      const error = await rejection(session.fork({ fromStep: 1, id }));
      expect(error.code).toBe('LOUSHO_SESSION_EXISTS');
      expect(error.field).toBe('id');
    }
    expect(await store.load('taken')).toEqual([{ role: 'user', content: 'mine' }]);
    expect((await session.fork({ fromStep: 1, id: 'branch' })).id).toBe('branch');
    await expect(session.fork({ fromStep: 1, id: 'no/slash' })).rejects.toMatchObject({ code: 'LOUSHO_SESSION_ID_INVALID' });
  });

  it('names forks <id>-fork-1, then <id>-fork-2', async () => {
    const { session } = await twoTurns();
    expect((await session.fork({ fromStep: 3 })).id).toBe('chat-fork-1');
    expect((await session.fork({ fromStep: 2 })).id).toBe('chat-fork-2');
  });

  it('replaces a tool result with patch.toolResult and leaves the original alone', async () => {
    const { model, session } = await twoTurns(['patched']);
    const fork = await session.fork({ fromStep: 1, patch: { toolResult: { toolCallId: 'c1', result: { temp: 3 } } } });
    expect((await fork.history())[0].toolCalls[0].result).toBe('{"temp":3}');
    await fork.send('so?');
    expect(convo(model.calls[3])[2]).toBe('tool:{"temp":3}');
    expect((await session.history())[0].toolCalls[0].result).toBe('"result for x"');

    const error = await rejection(session.fork({ fromStep: 1, patch: { toolResult: { toolCallId: 'nope', result: 1 } } }));
    expect(error.field).toBe('patch.toolResult');
  });

  it('rejects with LOUSHO_SESSION_BUSY while a turn is in flight', async () => {
    const session = createAgent({ provider: mockModel([{ text: 'slow', delayMs: 30 }]) }).session();
    const turn = session.send('hi');
    await expect(session.fork({ fromStep: 0 })).rejects.toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });
    await turn;
    expect((await session.fork({ fromStep: 1 })).messages).toBeDefined();
  });

  it('rejects with LOUSHO_SESSION_FORK_UNSUPPORTED on a session built without a spawner', async () => {
    const session = new AgentSession(async () => {
      throw new Error('not called');
    });
    await expect(session.fork({ fromStep: 0 })).rejects.toMatchObject({ code: 'LOUSHO_SESSION_FORK_UNSUPPORTED' });
  });

  it('saves a fork from a FileSessionStore session that a new agent.session() continues', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-fork-'));
    tempDirs.push(dir);
    const store = new FileSessionStore(dir);
    const { session } = await twoTurns([], { store });
    const fork = await session.fork({ fromStep: 2 });

    const model = mockModel(['later']);
    const reopened = createAgent({ provider: model }).session({ id: fork.id, store });
    expect((await reopened.history()).map((s) => s.text)).toEqual(['', 'It is x.']);
    await reopened.send('still there?');
    expect(convo(model.calls[0])).toEqual(['user:find x', 'assistant:', 'tool:"result for x"', 'assistant:It is x.', 'user:still there?']);
  });

  it('keeps the spend recorded up to the fork point for limits', async () => {
    const { session } = await twoTurns(['over'], { limits: { maxSteps: 3 } });
    const usageOf = (messages: readonly Message[]) => messages.at(-1)?.metadata?.sessionUsage as { steps: number } | undefined;
    const atTurnEnd = await session.fork({ fromStep: 2 });
    expect(usageOf(await atTurnEnd.load())?.steps).toBe(2);
    expect(usageOf(session.messages)?.steps).toBe(3);

    const full = await session.fork({ fromStep: 3 });
    const result = await full.send('more?');
    expect(result.finishReason).toBe('budget-exceeded');
    expect(result.budget).toMatchObject({ limit: 'maxSteps', scope: 'session' });
  });

  it('gives the fork the permission mode the session has when it forks (N4)', async () => {
    const session = createAgent({ provider: mockModel(['a']) }).session({ permissionMode: 'plan' });
    await session.send('hi');
    session.setPermissionMode('acceptEdits');
    const fork = await session.fork({ fromStep: 1 });
    expect(fork.permissionMode).toBe('acceptEdits');
    fork.setPermissionMode('default');
    expect(session.permissionMode).toBe('acceptEdits');
  });

  it('runs the fork under its own session id', async () => {
    const model = mockModel(['a', 'b']);
    const agent = createAgent({ provider: model, instructions: ({ sessionId }) => `session ${sessionId}` });
    const session = agent.session({ id: 'src' });
    await session.send('hi');
    const fork = await session.fork({ fromStep: 1 });
    await fork.send('again');
    expect(model.calls[1].messages[0]).toMatchObject({ role: 'system', content: 'session src-fork-1' });
  });

  it('pauses on a needsApproval tool in the fork, and approvals.resolve() continues the fork, not the original', async () => {
    approvedRuns = 0;
    const { model, agent, session } = await twoTurns([{ toolCalls: [{ name: 'send_email', id: 'e1' }] }, 'Email sent.']);
    const fork = await session.fork({ fromStep: 3 });
    const paused = await fork.send('email it');
    expect(paused.finishReason).toBe('awaiting-approval');

    const resumed = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(resumed.text).toBe('Email sent.');
    expect(approvedRuns).toBe(1);
    expect((await fork.history()).map((s) => s.text).at(-1)).toBe('Email sent.');
    expect((await fork.history()).at(-2)?.toolCalls[0]).toMatchObject({ name: 'send_email', result: '"sent"' });
    expect(session.messages).toHaveLength(6);
    expect(model.calls).toHaveLength(5);
  });
});

describe('forking a paused session', () => {
  const pausingScript: MockTurn[] = [lookupTurn, 'It is x.', { toolCalls: [{ name: 'send_email', id: 'e1' }] }, 'fork reply', 'Email sent.'];

  it.each([
    ['without checkpoints', () => ({})],
    ['with checkpoints', () => ({ store: memoryStore() })],
  ])('%s: the pending approval stays with the source and is resolved once', async (_name, storeOf) => {
    approvedRuns = 0;
    const model = mockModel(pausingScript);
    const agent = createAgent({ provider: model, tools: [lookup, sendEmail], ...storeOf() });
    const session = agent.session({ id: 'paused' });
    await session.send('find x');
    const paused = await session.send('email it');
    expect(paused.finishReason).toBe('awaiting-approval');
    const steps = (await session.history()).length;

    const fork = await session.fork({ fromStep: steps });
    expect(await fork.pending()).toBeNull();
    expect((await fork.load()).map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect((await fork.send('do not email')).text).toBe('fork reply');

    const resumed = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(resumed.text).toBe('Email sent.');
    expect(approvedRuns).toBe(1);
    expect((await session.history()).at(-1)?.text).toBe('Email sent.');
    expect((await fork.history()).at(-1)?.text).toBe('fork reply');
    await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toThrow();
  });

  it('with checkpoints, the source still reports its pending turn after the fork', async () => {
    const agent = createAgent({ provider: mockModel(pausingScript), tools: [lookup, sendEmail], store: memoryStore() });
    const session = agent.session({ id: 'held' });
    await session.send('find x');
    await session.send('email it');
    await session.fork({ fromStep: 2 });
    expect(await session.pending()).toMatchObject({ status: 'awaiting-approval' });
    await expect(session.send('more')).rejects.toBeInstanceOf(SessionAwaitingApprovalError);
  });
});
