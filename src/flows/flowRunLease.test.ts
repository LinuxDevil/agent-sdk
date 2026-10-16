/**
 * A durable flow run holds a run lease on its runId, as an agent run
 * does: two concurrent execute()/resume() calls of one run never both run its
 * steps, and a lease left by a crashed holder can be taken over.
 */

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentFlow } from '../types/flow';
import { FlowExecutor, type FlowExecutionContext, type FlowExecutionResult } from './FlowExecutor';
import { MockLLMProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { memoryStore } from '../storage/agentStore';
import { fileStore } from '../storage/fileStore';
import { SqliteStore } from '../storage/sqlite';
import { localLeaseInstance } from '../execution/runLease';
import type { CheckpointStore } from '../execution/checkpoint';

const sqliteStores: SqliteStore[] = [];
const tempDirs: string[] = [];
afterEach(() => {
  while (sqliteStores.length) sqliteStores.pop()?.close();
});
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-flow-lease-'));
  tempDirs.push(dir);
  return dir;
}

/** Two store objects over the same data (one object twice for the in-memory store). */
const implementations: Array<[string, () => [CheckpointStore, CheckpointStore]]> = [
  [
    'memoryStore()',
    () => {
      const store = memoryStore().checkpoints;
      return [store, store];
    },
  ],
  [
    'fileStore()',
    () => {
      const dir = tempDir();
      return [fileStore(dir).checkpoints, fileStore(dir).checkpoints];
    },
  ],
  [
    'SqliteStore',
    () => {
      const path = join(tempDir(), 'runs.db');
      const a = new SqliteStore(path);
      const b = new SqliteStore(path);
      sqliteStores.push(a, b);
      return [a.checkpoints, b.checkpoints];
    },
  ],
];

// A `sideEffect` step that takes a while, then a step that fails until `failing` is cleared.
const flow: AgentFlow = {
  code: 'leased',
  name: 'Leased',
  flow: {
    type: 'sequence',
    steps: [
      { type: 'toolCall', tool: 'sideEffect', arguments: {} },
      { type: 'toolCall', tool: 'gate', arguments: {} },
    ],
  },
};

describe.each(implementations)('durable flow run leases (%s)', (_name, open) => {
  let sideEffects: number;
  let failing: boolean;

  function context(store: CheckpointStore): FlowExecutionContext {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register('sideEffect', {
      displayName: 'Side effect',
      tool: {
        description: 'Counts its runs',
        parameters: z.object({}),
        execute: async () => {
          sideEffects++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return 'done';
        },
      },
    });
    toolRegistry.register('gate', {
      displayName: 'Gate',
      tool: {
        description: 'Fails while failing is set',
        parameters: z.object({}),
        execute: async () => {
          if (failing) throw new Error('not yet');
          return 'open';
        },
      },
    });
    return { agent: { name: 'flow-agent' }, provider: new MockLLMProvider({ name: 'mock' }), toolRegistry, variables: {}, checkpointStore: store, runId: 'run-1' };
  }

  function resumeContext(store: CheckpointStore) {
    const { variables: _variables, ...rest } = context(store);
    return { ...rest, checkpointStore: store, runId: 'run-1' };
  }

  function outcomes(results: PromiseSettledResult<FlowExecutionResult>[]) {
    const ran = results.filter((r): r is PromiseFulfilledResult<FlowExecutionResult> => r.status === 'fulfilled');
    const busy = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    return { ran, busy };
  }

  it('two concurrent execute() calls with one new runId: exactly one runs the steps, the other is LOUSHO_SESSION_BUSY', async () => {
    sideEffects = 0;
    failing = false;
    const [a, b] = open();
    const { ran, busy } = outcomes(await Promise.allSettled([FlowExecutor.execute(flow, context(a)), FlowExecutor.execute(flow, context(b))]));

    expect(sideEffects).toBe(1);
    expect(ran).toHaveLength(1);
    expect(ran[0].value.success).toBe(true);
    expect(busy).toHaveLength(1);
    expect(busy[0].reason).toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });
    expect((await a.load('run-1'))?.status).toBe('finished');
  });

  it('two concurrent resume() calls: exactly one runs the remaining steps; the lease is released after', async () => {
    sideEffects = 0;
    failing = true;
    const [a, b] = open();
    // The gate fails before the side effect, leaving an in-progress checkpoint.
    const gated: AgentFlow = {
      code: 'gated',
      name: 'Gated',
      flow: {
        type: 'sequence',
        steps: [
          { type: 'setVariable', variable: 'started', value: true },
          { type: 'toolCall', tool: 'gate', arguments: {} },
          { type: 'toolCall', tool: 'sideEffect', arguments: {} },
        ],
      },
    };
    expect((await FlowExecutor.execute(gated, context(a))).success).toBe(false);
    expect(sideEffects).toBe(0);

    failing = false;
    const { ran, busy } = outcomes(await Promise.allSettled([FlowExecutor.resume(gated, resumeContext(a)), FlowExecutor.resume(gated, resumeContext(b))]));

    expect(sideEffects).toBe(1);
    expect(ran).toHaveLength(1);
    expect(ran[0].value.success).toBe(true);
    expect(busy).toHaveLength(1);
    expect(busy[0].reason).toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });
    // Released: a later resume returns the finished run without running anything.
    const again = await FlowExecutor.resume(gated, resumeContext(b));
    expect(again.success).toBe(true);
    expect(sideEffects).toBe(1);
  });

  it('a lease left by a crashed holder is taken over by resume()', async () => {
    sideEffects = 0;
    failing = true;
    const [a, b] = open();
    expect((await FlowExecutor.execute(flow, context(a))).success).toBe(false);
    expect(sideEffects).toBe(1);

    // A holder in this realm that no longer runs (it crashed without releasing its lease).
    const crashed = `${process.pid}:${localLeaseInstance()}:${globalThis.crypto.randomUUID()}`;
    expect(await a.acquireLease!('run-1', crashed, 60_000)).toBe(true);

    failing = false;
    const result = await FlowExecutor.resume(flow, resumeContext(b));
    expect(result.success).toBe(true);
    expect(sideEffects).toBe(1); // the completed step is not run again
  });

  it('an expired lease is taken over by resume()', async () => {
    sideEffects = 0;
    failing = true;
    const [a, b] = open();
    expect((await FlowExecutor.execute(flow, context(a))).success).toBe(false);

    // Another host's holder whose lease ran out (and the grace period after it).
    expect(await a.acquireLease!('run-1', 'claim:elsewhere', 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    failing = false;
    expect((await FlowExecutor.resume(flow, resumeContext(b))).success).toBe(true);
  });
});
