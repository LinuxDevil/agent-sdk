import { describe, it, expect } from 'vitest';
import { ExecutionSnapshot, StorageServiceApprovalStore, PendingApproval } from './ApprovalGate';
import { describeApprovalStoreContract } from '../storage/sqlite/__fixtures__/storeContracts';
import { StorageService, FileSystemAdapter, PathAdapter } from '../storage/StorageService';

/**
 * A minimal in-memory fake of the Node fs/path modules, good enough to
 * exercise StorageService's real read/write/lock logic without touching
 * disk. Mirrors the mocking style already used in StorageService.test.ts,
 * but backs it with real state so round-trips are meaningful.
 */
function createFakeFs(): { fs: FileSystemAdapter; path: PathAdapter } {
  const files = new Map<string, string>();

  // Returns text only: StorageService reads with 'utf8' (the Buffer overload is unused).
  function readFileSync(p: string, encoding: 'utf8'): string;
  function readFileSync(p: string): Buffer;
  function readFileSync(p: string): string | Buffer {
    return files.get(p) as string;
  }

  const fs: FileSystemAdapter = {
    existsSync: (p: string) => files.has(p),
    mkdirSync: () => undefined,
    writeFileSync: (p: string, data: string | Uint8Array) => {
      files.set(p, typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    },
    unlinkSync: (p: string) => {
      files.delete(p);
    },
    readFileSync,
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

function createApprovalStore(): StorageServiceApprovalStore {
  const { fs, path } = createFakeFs();
  const storageService = new StorageService('test-db-hash', 'test-schema', fs, path, '/test/root');
  return new StorageServiceApprovalStore(storageService);
}

// The shared store contract (LOU-W5), including the Uint8Array round-trip (Eve DUR-F5, E14).
describeApprovalStoreContract('StorageServiceApprovalStore', createApprovalStore);

function buildSnapshot(pending: PendingApproval): ExecutionSnapshot {
  return {
    agent: {
      id: pending.agentId,
      name: 'Test Agent',
    },
    currentMessages: [{ role: 'user', content: 'do the thing' }],
    pendingToolCall: pending,
    steps: 1,
  };
}

describe('Execution - ApprovalGate types', () => {
  it('should round-trip an ExecutionSnapshot through JSON with no loss', () => {
    const snapshot: ExecutionSnapshot = {
      agent: {
        id: 'agent-1',
        name: 'Test Agent',
        prompt: 'You are a helpful assistant',
      },
      currentMessages: [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Please charge the card' },
      ],
      pendingToolCall: {
        id: 'approval-1',
        toolCallId: 'call-1',
        toolName: 'chargeCard',
        args: { amount: 500 },
        agentId: 'agent-1',
        createdAt: new Date().toISOString(),
      },
      steps: 1,
    };

    const roundTripped = JSON.parse(JSON.stringify(snapshot)) as ExecutionSnapshot;

    expect(roundTripped).toEqual(snapshot);
  });
});

describe('Execution - StorageServiceApprovalStore', () => {
  it('should round-trip save then resolve, keeping concurrent saves isolated', async () => {
    const store = createApprovalStore();

    const pendingA: PendingApproval = {
      id: 'approval-a',
      toolCallId: 'call-a',
      toolName: 'chargeCard',
      args: { amount: 100 },
      agentId: 'agent-a',
      createdAt: new Date().toISOString(),
    };
    const pendingB: PendingApproval = {
      id: 'approval-b',
      toolCallId: 'call-b',
      toolName: 'sendEmail',
      args: { to: 'user@example.com' },
      agentId: 'agent-b',
      createdAt: new Date().toISOString(),
    };

    await Promise.all([
      store.save(pendingA, buildSnapshot(pendingA)),
      store.save(pendingB, buildSnapshot(pendingB)),
    ]);

    const [resolvedA, resolvedB] = await Promise.all([
      store.resolve('approval-a'),
      store.resolve('approval-b'),
    ]);

    expect(resolvedA?.pending).toEqual(pendingA);
    expect(resolvedA?.snapshot).toEqual(buildSnapshot(pendingA));
    expect(resolvedB?.pending).toEqual(pendingB);
    expect(resolvedB?.snapshot).toEqual(buildSnapshot(pendingB));
  });

  it('should return null when resolving an id that was already resolved', async () => {
    const store = createApprovalStore();

    const pending: PendingApproval = {
      id: 'approval-once',
      toolCallId: 'call-once',
      toolName: 'chargeCard',
      args: { amount: 250 },
      createdAt: new Date().toISOString(),
    };

    await store.save(pending, buildSnapshot(pending));

    const first = await store.resolve('approval-once');
    expect(first?.pending).toEqual(pending);

    const second = await store.resolve('approval-once');
    expect(second).toBeNull();
  });

  it('should round-trip the LOU-U7 remainingToolCalls of a snapshot', async () => {
    const store = createApprovalStore();
    const pending: PendingApproval = {
      id: 'approval-mid-batch',
      toolCallId: 'call-b',
      toolName: 'chargeCard',
      args: {},
      createdAt: new Date().toISOString(),
    };
    const snapshot: ExecutionSnapshot = {
      ...buildSnapshot(pending),
      remainingToolCalls: [{ id: 'call-c', type: 'function', function: { name: 'sendEmail', arguments: '{"to":"a@b.c"}' } }],
    };

    await store.save(pending, snapshot);

    expect((await store.resolve('approval-mid-batch'))?.snapshot).toEqual(snapshot);
  });

  it('should return null for an id that was never saved', async () => {
    const store = createApprovalStore();
    const result = await store.resolve('never-saved');
    expect(result).toBeNull();
  });
});
