/**
 * Shared contract suites (LOU-W5): the same assertions run against every
 * implementation of SessionStore, CheckpointStore and ApprovalStore.
 * `factory` returns a fresh, empty store (and may be async).
 */
import { describe, it, expect } from 'vitest';
import type { SessionStore } from '../../../session/sessionStore';
import type { Checkpoint, CheckpointStore } from '../../../execution/checkpoint';
import type { ApprovalStore, ExecutionSnapshot, PendingApproval } from '../../../execution/ApprovalGate';
import { AgentType } from '../../../types';
import type { Message } from '../../../providers/llm';

type Factory<T> = () => T | Promise<T>;

const convo: Message[] = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
];

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

    it('does not alias the saved array', async () => {
      const store = await factory();
      const messages = structuredClone(convo);
      await store.save('a', messages);
      messages[0].content = 'tampered';
      expect((await store.load('a'))?.[0].content).toBe('hi');
    });

    it('refuses invalid session ids', async () => {
      const store = await factory();
      await expect(store.save('../x', convo)).rejects.toThrow(/Invalid session id/);
      await expect(store.load('a/b')).rejects.toThrow(/Invalid session id/);
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

    it('round-trips fields it does not know about (opaque JSON)', async () => {
      const store = await factory();
      const extended = { ...makeCheckpoint(), futureField: { nested: [1, 'two'] } } as Checkpoint;
      await store.save('run-1', extended);
      expect(await store.load('run-1')).toEqual(extended);
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
    agent: { id: 'agent-1', name: 'Test Agent', agentType: AgentType.SmartAssistant },
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
  });
}
