import { describe, it, expect, vi } from 'vitest';
import { Checkpoint, LocalStorageCheckpointStore } from './checkpoint';
import { StorageService } from '../storage/StorageService';
import { createFakeFs } from './__fixtures__/fakeFs';

function createCheckpointStore(): LocalStorageCheckpointStore {
  const { fs, path } = createFakeFs();
  const storageService = new StorageService('test-db-hash', 'test-schema', fs, path, '/test/root');
  return new LocalStorageCheckpointStore(storageService);
}

function buildCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    stepIndex: 2,
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ],
    toolCalls: [{ id: 'call-1', name: 'noop' }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    finishReason: 'tool_calls',
    ...overrides,
  };
}

describe('Execution - LocalStorageCheckpointStore', () => {
  it('should round-trip save then load deep-equal', async () => {
    const store = createCheckpointStore();
    const checkpoint = buildCheckpoint();

    await store.save('session-1', checkpoint);
    const loaded = await store.load('session-1');

    expect(loaded).toEqual(checkpoint);
  });

  it('should return null after delete then load', async () => {
    const store = createCheckpointStore();
    const checkpoint = buildCheckpoint();

    await store.save('session-1', checkpoint);
    await store.delete('session-1');

    const loaded = await store.load('session-1');
    expect(loaded).toBeNull();
  });

  it('should return null (not throw) when loading a never-saved sessionId', async () => {
    const store = createCheckpointStore();
    await expect(store.load('never-saved')).resolves.toBeNull();
  });

  it('should not throw when deleting a sessionId that was never saved', async () => {
    const store = createCheckpointStore();
    await expect(store.delete('never-saved')).resolves.toBeUndefined();
  });

  it('should acquire and release the same storage-key lock in load() as save()/delete() do', async () => {
    const { fs, path } = createFakeFs();
    const storageService = new StorageService('test-db-hash', 'test-schema', fs, path, '/test/root');
    const store = new LocalStorageCheckpointStore(storageService);

    const acquireSpy = vi.spyOn(storageService, 'acquireLock');
    const releaseSpy = vi.spyOn(storageService, 'releaseLock');

    const checkpoint = buildCheckpoint();
    await store.save('session-lock', checkpoint);
    acquireSpy.mockClear();
    releaseSpy.mockClear();

    await store.load('session-lock');

    expect(acquireSpy).toHaveBeenCalledWith('checkpoints/session-lock.json');
    expect(releaseSpy).toHaveBeenCalledWith('checkpoints/session-lock.json');
    // Lock must be released even though load() returns from inside the
    // try block (finally-based release, matching save()/delete()).
    expect(acquireSpy.mock.invocationCallOrder[0]).toBeLessThan(
      releaseSpy.mock.invocationCallOrder[0]
    );
  });

  // LOU-T1
  it('should round-trip an arbitrary businessState blob deep-equal', async () => {
    const store = createCheckpointStore();
    const checkpoint = buildCheckpoint({
      businessState: { orderId: 'ord_123', stage: 'awaiting-payment', retries: 2 },
    });

    await store.save('session-1', checkpoint);
    const loaded = await store.load('session-1');

    expect(loaded).toEqual(checkpoint);
    expect(loaded?.businessState).toEqual({
      orderId: 'ord_123',
      stage: 'awaiting-payment',
      retries: 2,
    });
  });

  // LOU-U8
  it('should round-trip status, approvalId and a transcript with queued input behind a pending turn', async () => {
    const store = createCheckpointStore();
    const checkpoint = buildCheckpoint({
      status: 'awaiting-approval',
      approvalId: 'approval-9',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'noop', arguments: '{}' } }] },
        { role: 'user', content: 'queued' },
      ],
    });

    await store.save('session-1', checkpoint);

    expect(await store.load('session-1')).toEqual(checkpoint);
  });

  it('should leave businessState absent (undefined) when never set - backward compatible', async () => {
    const store = createCheckpointStore();
    const checkpoint = buildCheckpoint();

    await store.save('session-1', checkpoint);
    const loaded = await store.load('session-1');

    expect(loaded?.businessState).toBeUndefined();
  });
});
