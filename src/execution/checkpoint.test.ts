import { describe, it, expect } from 'vitest';
import { Checkpoint, LocalStorageCheckpointStore } from './checkpoint';
import { StorageService, FileSystemAdapter, PathAdapter } from '../storage/StorageService';

/**
 * A minimal in-memory fake of the Node fs/path modules, good enough to
 * exercise StorageService's real read/write/lock logic without touching
 * disk. Mirrors the mocking style already used in StorageService.test.ts
 * and ApprovalGate.test.ts.
 */
function createFakeFs(): { fs: FileSystemAdapter; path: PathAdapter } {
  const files = new Map<string, string>();

  const fs: FileSystemAdapter = {
    existsSync: (p: string) => files.has(p),
    mkdirSync: () => undefined,
    writeFileSync: (p: string, data: string | Uint8Array) => {
      files.set(p, typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    },
    unlinkSync: (p: string) => {
      files.delete(p);
    },
    readFileSync: (p: string) => files.get(p) as any,
    rmSync: (p: string) => {
      files.delete(p);
    },
  };

  const path: PathAdapter = {
    join: (...parts: string[]) => parts.join('/'),
    resolve: (...parts: string[]) => parts.join('/'),
  };

  return { fs, path };
}

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
});
