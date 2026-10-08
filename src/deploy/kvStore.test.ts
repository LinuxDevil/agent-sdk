/**
 * LOU-D51: KVStore, the AgentStore on a Workers KV namespace, against a fake
 * binding (the same store runs once under workerd in adapters/cloudflare.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { compareTrajectories } from '../evals/drift';
import { mockModel, type MockTurn } from '../testing';
import type { Message } from '../providers/llm';
import type { ExecutionSnapshot, PendingApproval } from '../execution/ApprovalGate';
import { decodeBytes, encodeBytes } from '../session/sessionStore';
import type { KVBinding, KVPutOptions } from './kvCheckpointStore';
import { KVStore } from './kvStore';
import {
  describeApprovalStoreContract,
  describeCheckpointStoreContract,
  describeSessionStoreContract,
} from '../storage/sqlite/__fixtures__/storeContracts';

function fakeKV() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const kv: KVBinding = {
    get: async (key) => data.get(key) ?? null,
    put: async (key, value, options?: KVPutOptions) => {
      data.set(key, value);
      ttls.set(key, options?.expirationTtl);
    },
    delete: async (key) => void data.delete(key),
  };
  return { kv, data, ttls };
}

// The shared store contracts (LOU-W5), including the Uint8Array round-trip (Eve DUR-F5).
describeSessionStoreContract('KVStore.sessions', () => new KVStore(fakeKV().kv).sessions);
describeCheckpointStoreContract('KVStore.checkpoints', () => new KVStore(fakeKV().kv).checkpoints);
describeApprovalStoreContract('KVStore.approvals', () => new KVStore(fakeKV().kv).approvals);

const pending: PendingApproval = { id: 'ap-1', toolCallId: 'call-1', toolName: 'ping', args: { n: 1 }, createdAt: '2026-01-01T00:00:00.000Z' };
const snapshot = { currentMessages: [{ role: 'user', content: 'hi' }], pendingToolCall: pending, steps: 1 } as unknown as ExecutionSnapshot;

describe('KVStore sessions', () => {
  it('saves a transcript as JSON under sessions/<id>, loads it back, and deletes it', async () => {
    const { kv, data } = fakeKV();
    const { sessions } = new KVStore(kv);
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(await sessions.load('chat-1')).toBeUndefined();
    await sessions.save('chat-1', messages);
    expect(JSON.parse(data.get('sessions/chat-1')!)).toEqual(messages);
    expect(await sessions.load('chat-1')).toEqual(messages);
    await sessions.delete('chat-1');
    expect(await sessions.load('chat-1')).toBeUndefined();
    await expect(sessions.delete('chat-1')).resolves.toBeUndefined();
  });

  it('encodes bytes the way FileSessionStore does, so either side reads the other', async () => {
    const { kv, data } = fakeKV();
    const { sessions } = new KVStore(kv);
    const bytes = new Uint8Array(70_000).map((_, index) => index % 251);
    const messages = [{ role: 'user', content: [{ type: 'image', image: bytes, mediaType: 'image/png' }] }] as unknown as Message[];
    await sessions.save('img', messages);

    const raw = data.get('sessions/img')!;
    expect(raw).toContain('"$bytes"');
    expect(JSON.stringify(JSON.parse(raw, decodeBytes), encodeBytes)).toBe(JSON.stringify(messages, encodeBytes));
    const loaded = (await sessions.load('img'))!;
    expect(((loaded[0].content as unknown as Array<{ image: Uint8Array }>)[0]).image).toEqual(bytes);

    data.set('sessions/from-file', JSON.stringify(messages, encodeBytes));
    const fromFile = (await sessions.load('from-file'))!;
    expect(((fromFile[0].content as unknown as Array<{ image: Uint8Array }>)[0]).image).toEqual(bytes);
  });

  it('refuses ids that are not session ids', async () => {
    const { sessions } = new KVStore(fakeKV().kv);
    await expect(sessions.load('../x')).rejects.toThrow(/Invalid session id/);
    await expect(sessions.save('a/b', [])).rejects.toThrow(/Invalid session id/);
  });
});

describe('KVStore checkpoints and approvals', () => {
  it('keeps checkpoints under checkpoints/<id> (KVCheckpointStore)', async () => {
    const { kv, data } = fakeKV();
    const { checkpoints } = new KVStore(kv);
    const checkpoint = { agentId: 'a', sessionId: 's', stepIndex: 1, messages: [], toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    await checkpoints.save('s', checkpoint);
    expect(data.has('checkpoints/s')).toBe(true);
    expect(await checkpoints.load('s')).toEqual(checkpoint);
    await checkpoints.delete('s');
    expect(await checkpoints.load('s')).toBeNull();
  });

  it('saves an approval as JSON under approvals/<id> and resolves it exactly once', async () => {
    const { kv, data } = fakeKV();
    const { approvals } = new KVStore(kv);
    expect(await approvals.resolve('ap-1')).toBeNull();
    await approvals.save(pending, snapshot);
    expect(JSON.parse(data.get('approvals/ap-1')!)).toEqual({ pending, snapshot });
    expect(await approvals.resolve('ap-1')).toEqual({ pending, snapshot });
    expect(data.has('approvals/ap-1')).toBe(false);
    expect(await approvals.resolve('ap-1')).toBeNull();
  });
});

describe('KVStore options', () => {
  it('puts the prefix before every key', async () => {
    const { kv, data } = fakeKV();
    const store = new KVStore(kv, { prefix: 'bot-7/' });
    await store.sessions.save('a', []);
    await store.approvals.save(pending, snapshot);
    await store.checkpoints.save('a', { agentId: 'a', sessionId: 'a', stepIndex: 0, messages: [], toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    expect([...data.keys()].filter((key) => !key.includes('#history')).sort()).toEqual(['bot-7/approvals/ap-1', 'bot-7/checkpoints/a', 'bot-7/sessions/a']);
    expect([...data.keys()].filter((key) => key.includes('#history')).every((key) => key.startsWith('bot-7/checkpoints/a#history'))).toBe(true);
  });

  it('expires each kind of record with its own TTL, and none by default', async () => {
    const { kv, ttls } = fakeKV();
    const store = new KVStore(kv, { ttl: { sessions: 86_400, checkpoints: 3_600, approvals: 600 }, historyLimit: 0 });
    await store.sessions.save('a', []);
    await store.approvals.save(pending, snapshot);
    await store.checkpoints.save('a', { agentId: 'a', sessionId: 'a', stepIndex: 0, messages: [], toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    expect(Object.fromEntries(ttls)).toEqual({ 'sessions/a': 86_400, 'approvals/ap-1': 600, 'checkpoints/a': 3_600 });

    const plain = fakeKV();
    await new KVStore(plain.kv).sessions.save('a', []);
    expect(plain.ttls.get('sessions/a')).toBeUndefined();
  });
});

describe('createAgent({ store: new KVStore(kv) })', () => {
  it('continues a session in a new agent over the same namespace', async () => {
    const { kv } = fakeKV();
    const first = createAgent({ provider: mockModel(['Nice to meet you, Ali.']), store: new KVStore(kv) });
    await first.session({ id: 'tab-a' }).send('My name is Ali.');

    const provider = mockModel(['You are Ali.']);
    const second = createAgent({ provider, store: new KVStore(kv) });
    await second.session({ id: 'tab-a' }).send('Who am I?');
    expect(provider.calls[0].messages.map((m) => `${m.role}:${String(m.content)}`)).toEqual(
      expect.arrayContaining(['user:My name is Ali.', 'assistant:Nice to meet you, Ali.', 'user:Who am I?'])
    );
  });
});

describe('agent.fork() with a KVStore (LOU-D43.2)', () => {
  it('forks a run from its KV history, resumes the fork and compares the trajectories', async () => {
    const { kv } = fakeKV();
    const store = new KVStore(kv);
    const weather = defineTool({ name: 'weather', description: 'weather', input: z.object({}), execute: async () => ({ forecast: 'sunny' }) });
    const askWeather: MockTurn = { toolCalls: [{ name: 'weather', id: 'call_weather' }] };
    const report: MockTurn = (req) => `done: ${req.messages.at(-1)?.content}`;
    const provider = mockModel([askWeather, report, report]);
    const agent = createAgent({ provider, instructions: 'Report the weather.', tools: [weather], store });

    expect((await agent.send('Weather?', { sessionId: 'trip' })).text).toBe('done: {"forecast":"sunny"}');
    expect((await store.checkpoints.history('trip')).map((entry) => entry.step)).toEqual([2, 1, 1]); // the model turn and the tool result both save step 1

    const fork = await agent.fork('trip', { fromStep: 1, patch: { toolResult: { toolCallId: 'call_weather', result: { forecast: 'rain' } } } });
    expect(fork.sessionId).toBe('trip.fork-1');
    expect((await agent.resume(fork.sessionId))?.text).toBe('done: {"forecast":"rain"}');
    provider.assertExhausted();

    const original = await store.checkpoints.load('trip');
    const forked = await store.checkpoints.load(fork.sessionId);
    expect(compareTrajectories(original!, forked!).divergedAt).toBe(1);
  });
});
