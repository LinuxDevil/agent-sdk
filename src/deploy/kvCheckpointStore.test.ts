/**
 * LOU-T2: KVCheckpointStore unit tests, plus proof it satisfies whatever
 * resumeAfterApproval() expects from a CheckpointStore (the same contract
 * LocalStorageCheckpointStore/FileCheckpointStore already satisfy - see
 * src/execution/checkpoint.ts and apps/agent-forge/server/checkpointStore.ts).
 *
 * The real "does this work on an actual built Worker bundle" proof lives in
 * src/deploy/adapters/cloudflare.checkpoint.test.ts; this file exercises the
 * store directly (in-memory mock KVBinding - no real Cloudflare account/KV
 * namespace needed, same "reasonable mock object" approach the ticket calls
 * out since Miniflare/workers-types aren't already devDependencies here).
 */
import { describe, it, expect, vi } from 'vitest';
import { KVBinding, KVCheckpointStore, DEFAULT_KV_KEY_PREFIX } from './kvCheckpointStore';
import { Checkpoint } from '../execution/checkpoint';
import { resumeAfterApproval } from '../execution/resume';
import { ApprovalStore, PendingApproval, ExecutionSnapshot } from '../execution/ApprovalGate';
import { AgentExecutor } from '../execution/AgentExecutor';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';

/** Simple in-memory stand-in for a real Cloudflare KV namespace binding. */
function createMockKV(): KVBinding & { data: Map<string, string>; putCalls: [string, string][] } {
  const data = new Map<string, string>();
  const putCalls: [string, string][] = [];
  return {
    data,
    putCalls,
    async get(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    async put(key: string, value: string) {
      putCalls.push([key, value]);
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
  };
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    stepIndex: 1,
    messages: [{ role: 'user', content: 'hi' }],
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    ...overrides,
  };
}

describe('KVCheckpointStore', () => {
  it('save() JSON-serializes the checkpoint under keyPrefix+sessionId', async () => {
    const kv = createMockKV();
    const store = new KVCheckpointStore(kv);
    const checkpoint = makeCheckpoint();

    await store.save('session-1', checkpoint);

    expect(kv.data.get(`${DEFAULT_KV_KEY_PREFIX}session-1`)).toBe(JSON.stringify(checkpoint));
  });

  it('load() returns the round-tripped checkpoint, or null when absent', async () => {
    const kv = createMockKV();
    const store = new KVCheckpointStore(kv);
    const checkpoint = makeCheckpoint({ businessState: { orderId: 'o-42' } });

    expect(await store.load('session-1')).toBeNull();

    await store.save('session-1', checkpoint);
    expect(await store.load('session-1')).toEqual(checkpoint);
  });

  it('round-trips the LOU-U8 status and approvalId fields', async () => {
    const store = new KVCheckpointStore(createMockKV());
    const paused = makeCheckpoint({ status: 'awaiting-approval', approvalId: 'approval-1' });

    await store.save('session-1', paused);
    expect(await store.load('session-1')).toEqual(paused);

    await store.save('session-1', makeCheckpoint({ status: 'finished' }));
    expect((await store.load('session-1'))?.status).toBe('finished');
  });

  it('delete() removes the entry so a later load() misses', async () => {
    const kv = createMockKV();
    const store = new KVCheckpointStore(kv);
    await store.save('session-1', makeCheckpoint());

    await store.delete('session-1');

    expect(await store.load('session-1')).toBeNull();
    expect(kv.data.has(`${DEFAULT_KV_KEY_PREFIX}session-1`)).toBe(false);
  });

  it('delete() on a missing key is a no-op (mirrors LocalStorageCheckpointStore/FileCheckpointStore)', async () => {
    const kv = createMockKV();
    const store = new KVCheckpointStore(kv);
    await expect(store.delete('never-existed')).resolves.toBeUndefined();
  });

  it('namespaces sessions with a custom keyPrefix so two stores sharing one KV namespace never collide', async () => {
    const kv = createMockKV();
    const storeA = new KVCheckpointStore(kv, 'app-a/');
    const storeB = new KVCheckpointStore(kv, 'app-b/');

    await storeA.save('session-1', makeCheckpoint({ agentId: 'a' }));
    await storeB.save('session-1', makeCheckpoint({ agentId: 'b' }));

    expect((await storeA.load('session-1'))?.agentId).toBe('a');
    expect((await storeB.load('session-1'))?.agentId).toBe('b');
  });

  it('only touches the injected KVBinding (get/put/delete) - proves this module has no hidden platform dependency', async () => {
    const get = vi.fn().mockResolvedValue(null);
    const put = vi.fn().mockResolvedValue(undefined);
    const del = vi.fn().mockResolvedValue(undefined);
    const store = new KVCheckpointStore({ get, put, delete: del }, undefined, undefined, { historyLimit: 0 });

    await store.load('s');
    await store.save('s', makeCheckpoint());
    await store.delete('s'); // delete also reads and removes the (empty) history index

    expect(get).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(2);
  });

  it("satisfies resumeAfterApproval()'s CheckpointStore contract: the resumed run keeps writing NEW checkpoints through this store for post-resume tool-call steps (LOU-K5, KV-backed)", async () => {
    // Mirrors src/execution/resume.test.ts's LOU-K5
    // "writes a NEW checkpoint for a tool-call step taken after a successful
    // resume" coverage, but backed by KVCheckpointStore + a mock KV binding
    // instead of a bespoke in-memory CheckpointStore - proving the KV-backed
    // store genuinely satisfies what resumeAfterApproval() expects, not
    // just a hand-rolled test double.
    //
    // Note: an approval-gated pause itself (the 'awaiting-approval'
    // early-return in AgentExecutor.ts) does NOT write a checkpoint - only
    // ApprovalStore records the pending decision, so there is deliberately
    // no "checkpoint exists before resume" assertion here. What this test
    // proves is the forward-checkpointing LOU-K5 fixed: once resumed, a
    // LATER tool-call step in the same run must still be checkpointed
    // through this exact KVCheckpointStore instance.
    const kv = createMockKV();
    const checkpointStore = new KVCheckpointStore(kv);
    const sessionId = 'kv-approval-session';

    const toolRegistry = new ToolRegistry();
    const chargeExecute = vi.fn().mockResolvedValue({ charged: true });
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute: chargeExecute } as any,
      needsApproval: true,
    });
    const lookupExecute = vi.fn().mockResolvedValue({ found: true });
    toolRegistry.register('lookup', {
      displayName: 'Lookup',
      tool: { description: 'Look something up', parameters: {}, execute: lookupExecute } as any,
      needsApproval: false,
    });

    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('chargeCard', { tool: 'chargeCard', options: {} })
      .addTool('lookup', { tool: 'lookup', options: {} })
      .build();

    // Generation 1: calls the approval-gated chargeCard tool (pauses).
    // Generation 2 (post-resume): calls the unguarded lookup tool - the
    // "one more tool-call step after resume" that must get checkpointed to
    // KV. Generation 3: stops with no further tool calls.
    let call = 0;
    const scriptedProvider = {
      name: 'scripted',
      supportsTools: () => true,
      supportsStreaming: () => false,
      getModels: async () => ['scripted'],
      stream: async () => {
        throw new Error('not implemented');
      },
      generate: async () => {
        call++;
        if (call === 1) {
          return {
            text: 'charging',
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              { id: 'call-charge', type: 'function' as const, function: { name: 'chargeCard', arguments: '{}' } },
            ],
          };
        }
        if (call === 2) {
          return {
            text: 'looking up',
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              { id: 'call-lookup', type: 'function' as const, function: { name: 'lookup', arguments: '{}' } },
            ],
          };
        }
        return {
          text: 'all done',
          finishReason: 'stop' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };

    const records = new Map<string, { pending: PendingApproval; snapshot: ExecutionSnapshot }>();
    const approvalStore: ApprovalStore = {
      async save(pending, snapshot) {
        records.set(pending.id, { pending, snapshot });
      },
      async resolve(id) {
        const record = records.get(id);
        if (!record) return null;
        records.delete(id);
        return record;
      },
    };

    const paused = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: scriptedProvider as any,
      toolRegistry,
      approvalStore,
      sessionId,
      checkpointStore,
    });
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(chargeExecute).not.toHaveBeenCalled();

    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      scriptedProvider as any,
      {},
      checkpointStore
    );

    expect(resumed.finishReason).toBe('stop');
    expect(chargeExecute).toHaveBeenCalledTimes(1);
    expect(lookupExecute).toHaveBeenCalledTimes(1);

    // The run reached a terminal state, so its checkpoint is kept, marked
    // 'finished' (LOU-U8). The raw KV entry having been written via the
    // store's put is asserted below from the mock KV's call history.
    expect(kv.putCalls.some(([key]) => key === `${DEFAULT_KV_KEY_PREFIX}${sessionId}`)).toBe(true);
    expect((await checkpointStore.load(sessionId))?.status).toBe('finished');
  });
});

describe('KVCheckpointStore history layout (LOU-D43.2)', () => {
  const sessionId = 'session-1';
  const base = `${DEFAULT_KV_KEY_PREFIX}${sessionId}`;

  it('keeps the latest checkpoint under the unchanged key and loads one written before history existed', async () => {
    const kv = createMockKV();
    const legacy = makeCheckpoint({ stepIndex: 4 });
    kv.data.set(base, JSON.stringify(legacy));
    const store = new KVCheckpointStore(kv);
    expect(await store.load(sessionId)).toEqual(legacy);
    expect(await store.history(sessionId)).toEqual([]);

    await store.save(sessionId, makeCheckpoint({ stepIndex: 5 }));
    expect(JSON.parse(kv.data.get(base)!).stepIndex).toBe(5);
    expect((await store.history(sessionId)).map((entry) => entry.step)).toEqual([5]);
  });

  it('prunes dropped entries from KV and delete() removes every history key', async () => {
    const kv = createMockKV();
    const store = new KVCheckpointStore(kv, undefined, undefined, { historyLimit: 2 });
    for (let step = 1; step <= 4; step++) await store.save(sessionId, makeCheckpoint({ stepIndex: step }));
    const historyKeys = () => [...kv.data.keys()].filter((key) => key.includes('#history'));
    expect(historyKeys()).toHaveLength(3); // the index and two entries
    await store.delete(sessionId, { keepHistory: true });
    expect(historyKeys()).toHaveLength(3);
    await store.delete(sessionId);
    expect([...kv.data.keys()]).toEqual([]);
  });

  it('survives a crash between writes: an orphan entry, a row without its entry or a corrupt index is harmless', async () => {
    const kv = createMockKV();
    const store = new KVCheckpointStore(kv);
    await store.save(sessionId, makeCheckpoint({ stepIndex: 1 }));
    await store.save(sessionId, makeCheckpoint({ stepIndex: 2 }));
    const index = JSON.parse(kv.data.get(`${base}#history`)!) as string[];
    kv.data.delete(`${base}#history/${index[1]}`); // not propagated yet
    kv.data.set(`${base}#history/orphan`, '{}'); // entry saved, index write lost
    expect((await store.history(sessionId)).map((entry) => entry.step)).toEqual([1]);
    kv.data.set(`${base}#history`, 'not json');
    expect(await store.history(sessionId)).toEqual([]);
    expect((await store.load(sessionId))?.stepIndex).toBe(2);
  });

  it('writes the latest checkpoint first, then the entry, then the index', async () => {
    const kv = createMockKV();
    await new KVCheckpointStore(kv).save(sessionId, makeCheckpoint());
    expect(kv.putCalls.map(([key]) => key.slice(base.length).replace(/\/.+/, '/<id>'))).toEqual(['', '#history/<id>', '#history']);
  });
});
