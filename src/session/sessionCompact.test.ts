/**
 * LOU-W8: session.compact() and session.clear().
 */
import { describe, it, expect } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { pinMessage } from '../context/compaction';
import { SqliteStore } from '../storage/sqlite';
import { MemorySessionStore } from './index';
import type { SessionStore } from './sessionStore';
import type { AgentEvent } from '../execution/agentEvents';
import { SDKError } from '../execution/errors';
import type { Message } from '../providers/llm';

const big = 'x'.repeat(2_000);
const toolTurn = (id: string): Message[] => [
  { role: 'user', content: `look up ${id}` },
  { role: 'assistant', content: '', toolCalls: [{ id, type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
  { role: 'tool', toolCallId: id, toolName: 'lookup', content: big },
  { role: 'assistant', content: `done ${id}` },
];

function stores(): [string, () => SessionStore][] {
  return [
    ['memory', () => new MemorySessionStore()],
    ['sqlite', () => new SqliteStore(':memory:').sessions],
  ];
}

describe.each(stores())('session.compact() / clear() on the %s store', (_name, makeStore) => {
  const seeded = async (messages: Message[]) => {
    const store = makeStore();
    if (messages.length > 0) await store.save('s1', messages);
    const session = createAgent({ provider: mockModel(['ok']) }).session({ id: 's1', store });
    return { store, session };
  };

  it('compacts now, saves, emits manual events and keeps pinned messages', async () => {
    const pinned = pinMessage({ role: 'user', content: 'Always answer in French.' });
    const { store, session } = await seeded([pinned, ...toolTurn('a'), ...toolTurn('b')]);
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));

    const result = await session.compact({ protectedTokens: 50 });

    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(result.strategy).toBe('prune-tool-results');
    expect(events.map((e) => e.type)).toEqual(['compaction.start', 'compaction.done']);
    expect(events.map((e) => (e as { trigger?: string }).trigger)).toEqual(['manual', 'manual']);
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    const saved = await store.load('s1');
    expect(saved?.[0]).toMatchObject({ content: 'Always answer in French.', metadata: { pinned: true } });
    expect(saved?.[3].content).toMatch(/^\[pruned: lookup result/);
    expect(session.messages[3].content).toMatch(/^\[pruned/);
  });

  it('is a no-op on an empty session and on one with nothing to compact', async () => {
    const empty = await seeded([]);
    expect(await empty.session.compact()).toMatchObject({ messagesBefore: 0, messagesAfter: 0 });
    const small = await seeded([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    const result = await small.session.compact();
    expect(result.tokensAfter).toBe(result.tokensBefore);
    expect(await small.store.load('s1')).toHaveLength(2);
  });

  it('clear() empties the transcript, keeps the id, emits context.cleared and works again after', async () => {
    const { store, session } = await seeded(toolTurn('a'));
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));
    await session.clear();

    expect(session.id).toBe('s1');
    expect(session.messages).toEqual([]);
    expect((await store.load('s1')) ?? []).toEqual([]);
    expect(events).toMatchObject([{ type: 'context.cleared', sessionId: 's1', messagesCleared: 4 }]);
    await session.send('again');
    expect(session.messages).toHaveLength(2);
  });

  it('rejects with LOUSHO_SESSION_BUSY while a turn is in flight', async () => {
    const { session } = await seeded([]);
    const turn = session.send('go');
    await expect(session.compact()).rejects.toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });
    await expect(session.clear()).rejects.toBeInstanceOf(SDKError);
    await turn;
    await expect(session.clear()).resolves.toBeUndefined();
  });
});

describe('compaction strategy of a session', () => {
  it('uses options.strategy and reports a failing one without changing the transcript', async () => {
    const store = new MemorySessionStore();
    await store.save('s2', toolTurn('a'));
    const failing = { name: 'boom', compact: () => Promise.reject(new Error('nope')) };
    const session = createAgent({ provider: mockModel([]) }).session({ id: 's2', store, compaction: { protectedTokens: 10 } });
    const result = await session.compact({ strategy: failing });
    expect(result).toMatchObject({ strategy: 'boom', error: { message: 'nope' } });
    expect(await store.load('s2')).toEqual(toolTurn('a'));
  });

  it("agent.session() uses the agent's compaction setting (W8 follow-up)", async () => {
    const store = new MemorySessionStore();
    await store.save('s4', toolTurn('a'));
    const strategy = { name: 'agent-strategy', compact: async (messages: Message[]) => messages };
    const session = createAgent({ provider: mockModel([]), compaction: { strategy } }).session({ id: 's4', store });
    expect((await session.compact()).strategy).toBe('agent-strategy');
  });

  it('the session compaction option supplies the sizes', async () => {
    const store = new MemorySessionStore();
    await store.save('s3', [...toolTurn('a'), ...toolTurn('b')]);
    const session = createAgent({ provider: mockModel([]) }).session({ id: 's3', store, compaction: { protectedTokens: 10 } });
    const result = await session.compact();
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });
});
