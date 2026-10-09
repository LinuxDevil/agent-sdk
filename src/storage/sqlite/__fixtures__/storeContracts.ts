/**
 * Shared contract suites (LOU-W5): the same assertions run against every
 * implementation of SessionStore, CheckpointStore and ApprovalStore.
 * `factory` returns a fresh, empty store (and may be async).
 */
import { describe, it, expect } from 'vitest';
import { transcriptRevision, type SessionStore } from '../../../session/sessionStore';
import type { Checkpoint, CheckpointStore } from '../../../execution/checkpoint';
import type { ApprovalStore, ExecutionSnapshot, PendingApproval } from '../../../execution/ApprovalGate';
import type { Message } from '../../../providers/llm';

type Factory<T> = () => T | Promise<T>;

const convo: Message[] = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
];

/** A transcript holding image and file bytes (Eve DUR-F5): they must come back as `Uint8Array`, not `{ "0": 137, ... }`. */
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
export const convoWithBytes: Message[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'photo of the dent' },
      { type: 'image', image: png, mimeType: 'image/png' },
      { type: 'file', data: new Uint8Array([37, 80, 68, 70]), mimeType: 'application/pdf' },
    ],
  },
  { role: 'assistant', content: 'got it' },
];

const bytesOf = (messages: readonly Message[] | undefined): unknown[] =>
  (messages ?? []).flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.map((part) => ('image' in part ? part.image : 'data' in part ? part.data : undefined)).filter((v) => v !== undefined)
      : []
  );

/** Asserts every image/file part came back as a `Uint8Array` with the original bytes. */
export function expectBytesRoundTrip(messages: readonly Message[] | undefined): void {
  const got = bytesOf(messages);
  const want = bytesOf(convoWithBytes);
  expect(got).toHaveLength(want.length);
  got.forEach((value, i) => {
    expect(value).toBeInstanceOf(Uint8Array);
    expect(Array.from(value as Uint8Array)).toEqual(Array.from(want[i] as Uint8Array));
  });
}

export function describeSessionStoreContract(name: string, factory: Factory<SessionStore>): void {
  describe(`SessionStore contract: ${name}`, () => {
    it('returns undefined for an id that was never saved', async () => {
      expect(await (await factory()).load('nope')).toBeUndefined();
    });

    it('round-trips a transcript and replaces it on save', async () => {
      const store = await factory();
      await store.save('a', convo);
      expect(await store.load('a')).toEqual(convo);
      await store.save('a', [convo[0]]);
      expect(await store.load('a')).toEqual([convo[0]]);
    });

    it('keeps sessions isolated and tolerates delete of a missing id', async () => {
      const store = await factory();
      await store.save('a', convo);
      await store.save('b', [convo[0]]);
      await store.delete('a');
      await store.delete('missing');
      expect(await store.load('a')).toBeUndefined();
      expect(await store.load('b')).toEqual([convo[0]]);
    });

    it('keeps ids that differ only in case apart (Eve DUR-F7)', async () => {
      const store = await factory();
      await store.save('Alice', convo);
      expect(await store.load('alice')).toBeUndefined();
      await store.save('alice', [convo[0]]);
      expect(await store.load('Alice')).toEqual(convo);
      expect(await store.load('alice')).toEqual([convo[0]]);
      await store.delete('alice');
      expect(await store.load('Alice')).toEqual(convo);
    });

    it('does not alias the saved array', async () => {
      const store = await factory();
      const messages = structuredClone(convo);
      await store.save('a', messages);
      messages[0].content = 'tampered';
      expect((await store.load('a'))?.[0].content).toBe('hi');
    });

    it('round-trips image and file bytes as Uint8Array (Eve DUR-F5)', async () => {
      const store = await factory();
      await store.save('a', convoWithBytes);
      expectBytesRoundTrip(await store.load('a'));
    });

    it('refuses invalid session ids', async () => {
      const store = await factory();
      await expect(store.save('../x', convo)).rejects.toThrow(/Invalid session id/);
      await expect(store.load('a/b')).rejects.toThrow(/Invalid session id/);
    });

    // Eve DUR-F4: the optional compare-and-swap a session commits through.
    it('saveIf saves only over the expected revision', async () => {
      const store = await factory();
      if (!store.saveIf) return;
      expect(await store.saveIf('a', transcriptRevision(undefined), convo)).toBe(true);
      expect(await store.load('a')).toEqual(convo);
      // The revision of the empty transcript no longer matches.
      expect(await store.saveIf('a', transcriptRevision([]), [convo[0]])).toBe(false);
      expect(await store.load('a')).toEqual(convo);
      expect(await store.saveIf('a', transcriptRevision(convo), [convo[0]])).toBe(true);
      expect(await store.load('a')).toEqual([convo[0]]);
      await store.save('b', convoWithBytes);
      expect(await store.saveIf('b', transcriptRevision(convoWithBytes), convo)).toBe(true);
    });

    it('saveIf lets exactly one of two concurrent writers over the same revision win', async () => {
      const store = await factory();
      if (!store.saveIf) return;
      await store.save('a', convo);
      const base = transcriptRevision(convo);
      const results = await Promise.all([
        store.saveIf('a', base, [...convo, { role: 'user', content: 'one' }]),
        store.saveIf('a', base, [...convo, { role: 'user', content: 'two' }]),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await store.load('a')).toHaveLength(3);
    });
  });
}

export function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    agentId: 'agent-1',
    sessionId: 'run-1',
    stepIndex: 2,
    messages: convo,
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    ...overrides,
  };
}

export function describeCheckpointStoreContract(name: string, factory: Factory<CheckpointStore>): void {
  describe(`CheckpointStore contract: ${name}`, () => {
    it('returns null when nothing was saved', async () => {
      expect(await (await factory()).load('run-1')).toBeNull();
    });

    it('round-trips and overwrites a checkpoint, including businessState', async () => {
      const store = await factory();
      const first = makeCheckpoint({ businessState: { orderId: 7 } });
      await store.save('run-1', first);
      expect(await store.load('run-1')).toEqual(first);
      const second = makeCheckpoint({ stepIndex: 3 });
      await store.save('run-1', second);
      expect(await store.load('run-1')).toEqual(second);
    });

    it('keeps sessions isolated and tolerates delete of a missing id', async () => {
      const store = await factory();
      await store.save('a', makeCheckpoint({ sessionId: 'a' }));
      await store.save('b', makeCheckpoint({ sessionId: 'b' }));
      await store.delete('a');
      await store.delete('missing');
      expect(await store.load('a')).toBeNull();
      expect((await store.load('b'))?.sessionId).toBe('b');
    });

    it('keeps ids that differ only in case apart (Eve DUR-F7)', async () => {
      const store = await factory();
      await store.save('Run-1', makeCheckpoint({ sessionId: 'Run-1' }));
      expect(await store.load('run-1')).toBeNull();
      await store.save('run-1', makeCheckpoint({ sessionId: 'run-1' }));
      expect((await store.load('Run-1'))?.sessionId).toBe('Run-1');
      expect((await store.load('run-1'))?.sessionId).toBe('run-1');
    });

    it('round-trips fields it does not know about (opaque JSON)', async () => {
      const store = await factory();
      const extended = { ...makeCheckpoint(), futureField: { nested: [1, 'two'] } } as Checkpoint;
      await store.save('run-1', extended);
      expect(await store.load('run-1')).toEqual(extended);
    });

    it('round-trips image and file bytes as Uint8Array (Eve DUR-F5)', async () => {
      const store = await factory();
      await store.save('run-1', makeCheckpoint({ messages: convoWithBytes }));
      expectBytesRoundTrip((await store.load('run-1'))?.messages);
    });
  });
}

export function makePending(id: string, overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id,
    toolCallId: `call-${id}`,
    toolName: 'chargeCard',
    args: { amount: 100 },
    agentId: 'agent-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeSnapshot(pending: PendingApproval): ExecutionSnapshot {
  return {
    agent: { id: 'agent-1', name: 'Test Agent' },
    currentMessages: convo,
    pendingToolCall: pending,
    steps: 1,
    sessionId: 'run-1',
  };
}

export function describeApprovalStoreContract(name: string, factory: Factory<ApprovalStore>): void {
  describe(`ApprovalStore contract: ${name}`, () => {
    it('returns null for an id that was never saved', async () => {
      expect(await (await factory()).resolve('nope')).toBeNull();
    });

    it('resolves a saved approval exactly once', async () => {
      const store = await factory();
      const pending = makePending('a');
      await store.save(pending, makeSnapshot(pending));
      expect(await store.resolve('a')).toEqual({ pending, snapshot: makeSnapshot(pending) });
      expect(await store.resolve('a')).toBeNull();
    });

    it('keeps ids that differ only in case apart (Eve DUR-F7)', async () => {
      const store = await factory();
      const upper = makePending('Pay-1');
      await store.save(upper, makeSnapshot(upper));
      expect(await store.resolve('pay-1')).toBeNull();
      const lower = makePending('pay-1', { toolName: 'sendEmail' });
      await store.save(lower, makeSnapshot(lower));
      expect((await store.resolve('Pay-1'))?.pending).toEqual(upper);
      expect((await store.resolve('pay-1'))?.pending).toEqual(lower);
    });

    it('keeps concurrent saves isolated', async () => {
      const store = await factory();
      const a = makePending('a');
      const b = makePending('b', { toolName: 'sendEmail' });
      await Promise.all([store.save(a, makeSnapshot(a)), store.save(b, makeSnapshot(b))]);
      const [ra, rb] = await Promise.all([store.resolve('a'), store.resolve('b')]);
      expect(ra?.pending).toEqual(a);
      expect(rb?.pending).toEqual(b);
    });

    it('round-trips snapshot fields it does not know about (opaque JSON)', async () => {
      const store = await factory();
      const pending = makePending('a');
      const snapshot = { ...makeSnapshot(pending), futureField: { x: [true] } } as ExecutionSnapshot;
      await store.save(pending, snapshot);
      expect((await store.resolve('a'))?.snapshot).toEqual(snapshot);
    });

    it('load() reads a saved approval without resolving it, and stops answering once resolved', async () => {
      const store = await factory();
      const pending = makePending('a');
      const snapshot = makeSnapshot(pending);
      await store.save(pending, snapshot);
      expect(store.load).toBeTypeOf('function');
      expect(await store.load!('a')).toEqual({ pending, snapshot });
      expect(await store.resolve('a')).toEqual({ pending, snapshot }); // the read did not claim it
      expect(await store.load!('a')).toBeNull();
    });

    it('list() returns the unresolved approvals oldest first, without the resolved ones (Eve TOOLS-F13)', async () => {
      const store = await factory();
      if (!store.list) return; // optional: a store without it is listed by this process only
      expect(await store.list()).toEqual([]);
      const late = makePending('late', { createdAt: '2026-01-03T00:00:00.000Z' });
      const early = makePending('early', { createdAt: '2026-01-01T00:00:00.000Z' });
      const gone = makePending('gone', { createdAt: '2026-01-02T00:00:00.000Z' });
      for (const pending of [late, early, gone]) await store.save(pending, makeSnapshot(pending));
      await store.resolve('gone');
      expect(await store.list()).toEqual([early, late]);
    });

    it('round-trips image and file bytes in the snapshot as Uint8Array (Eve DUR-F5)', async () => {
      const store = await factory();
      const pending = makePending('a');
      await store.save(pending, { ...makeSnapshot(pending), currentMessages: convoWithBytes });
      expectBytesRoundTrip((await store.load!('a'))?.snapshot.currentMessages);
      expectBytesRoundTrip((await store.resolve('a'))?.snapshot.currentMessages);
    });
  });
}
