/**
 * `agent.recover()` finishes interrupted runs on its own, once their
 * crashed holder's run lease expires, and leaves approval pauses alone.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent } from './createAgent';
import { defineTool, type DefinedTool } from './tools/defineTool';
import { PropagatingToolError } from './execution/AgentExecutor';
import { fileStore } from './storage/fileStore';
import { memoryStore } from './storage/agentStore';
import { mockModel, type MockTurn } from './testing';
import type { PendingRun } from './agentPending';
import type { RunRecovery } from './agentRecover';

const calling = (name: string, id = `call_${name}`): MockTurn => ({ toolCalls: [{ name, id }] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `charge` counts its calls; `crash` dies the first `crashes` times it runs, as the process would. */
function tools(runs: Record<string, number>, crashes = 1): DefinedTool[] {
  runs.charge ??= 0;
  runs.crash ??= 0;
  runs.send_email ??= 0;
  return [
    defineTool({ name: 'charge', description: 'charge', input: z.object({}), execute: async () => `charged ${++runs.charge}` }),
    defineTool({
      name: 'crash',
      description: 'crash',
      input: z.object({}),
      execute: async () => {
        if (++runs.crash <= crashes) throw new PropagatingToolError('process died');
        return 'ok';
      },
    }),
    defineTool({ name: 'send_email', description: 'email', input: z.object({}), needsApproval: true, execute: async () => `sent ${++runs.send_email}` }),
  ];
}

const dirs: string[] = [];
const loops: RunRecovery[] = [];
afterEach(async () => {
  while (loops.length) await loops.pop()?.stop();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('agent.recover()', () => {
  it('finishes a crashed run once its lease expires, without re-running completed steps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-recover-'));
    dirs.push(dir);
    const runs: Record<string, number> = {};
    // Step 0 charges (checkpointed), step 1 dies mid-step.
    const before = createAgent({ provider: mockModel([calling('charge'), calling('crash')]), tools: tools(runs), store: fileStore(dir) });
    await expect(before.send('charge and finish', { sessionId: 'job-1' })).rejects.toThrow('process died');
    // The dead process still holds the run's lease, from another host: it is only free once it expired (TTL + one period of clock-skew grace).
    expect(await fileStore(dir).checkpoints.acquireLease!('job-1', 'crashed-host:worker-1', 150)).toBe(true);

    const after = createAgent({ provider: mockModel(['all done']), tools: tools(runs), store: fileStore(dir) });
    const recovered: Array<[PendingRun, string]> = [];
    const onError = vi.fn();
    loops.push(after.recover({ intervalMs: 20, onError, onRecovered: (run, result) => recovered.push([run, result.text]) }));

    // While the lease is live, sweeps are turned away before anything runs.
    await sleep(100);
    expect(recovered).toEqual([]);
    expect(await after.pending()).toEqual([expect.objectContaining({ sessionId: 'job-1', status: 'in-progress' })]);

    await vi.waitFor(() => expect(recovered).toHaveLength(1), { timeout: 3000 });
    expect(recovered[0]).toEqual([expect.objectContaining({ sessionId: 'job-1', kind: 'run' }), 'all done']);
    // The completed charge did not run again; only the call that was mid-flight did.
    expect(runs).toMatchObject({ charge: 1, crash: 2 });
    expect(await after.pending()).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('leaves runs paused on an approval alone', async () => {
    const store = memoryStore();
    const runs: Record<string, number> = {};
    const agent = createAgent({ provider: mockModel([calling('send_email'), calling('crash'), 'recovered']), tools: tools(runs), store });
    const paused = await agent.send('email Sam', { sessionId: 'job-approval' });
    expect(paused.finishReason).toBe('awaiting-approval');
    await expect(agent.send('crash', { sessionId: 'job-crash' })).rejects.toThrow('process died');

    const recovered: string[] = [];
    const onError = vi.fn();
    const recovery = agent.recover({ intervalMs: 10, onError, onRecovered: (run) => recovered.push(run.sessionId) });
    loops.push(recovery);
    await vi.waitFor(() => expect(recovered).toEqual(['job-crash']));
    await sleep(50);
    await recovery.stop();

    expect(recovered).toEqual(['job-crash']);
    expect(runs.send_email).toBe(0);
    expect(await agent.pending()).toEqual([expect.objectContaining({ sessionId: 'job-approval', status: 'awaiting-approval', approvalId: paused.approvalId })]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('stops polling when its signal aborts', async () => {
    const store = memoryStore();
    const runs: Record<string, number> = {};
    const agent = createAgent({ provider: mockModel([calling('crash'), 'finished']), tools: tools(runs), store });
    const controller = new AbortController();
    const onRecovered = vi.fn();
    const recovery = agent.recover({ intervalMs: 10, signal: controller.signal, onRecovered });
    await sleep(30);
    controller.abort();
    await recovery.done;

    // A run interrupted after the loop stopped stays pending.
    await expect(agent.send('crash', { sessionId: 'job-late' })).rejects.toThrow('process died');
    await sleep(50);
    expect(onRecovered).not.toHaveBeenCalled();
    expect(await agent.pending()).toEqual([expect.objectContaining({ sessionId: 'job-late', status: 'in-progress' })]);

    // An already-aborted signal never sweeps.
    const list = vi.spyOn(store.checkpoints, 'list');
    await agent.recover({ signal: AbortSignal.abort() }).done;
    expect(list).not.toHaveBeenCalled();
  });

  it('reports a resume that fails, and keeps going', async () => {
    const store = memoryStore();
    const runs: Record<string, number> = {};
    const agent = createAgent({ provider: mockModel([calling('crash'), calling('crash', 'call_2'), calling('crash', 'call_3')]), tools: tools(runs, Infinity), store });
    await expect(agent.send('crash', { sessionId: 'job-bad' })).rejects.toThrow('process died');
    const onError = vi.fn(() => {
      throw new Error('a throwing onError does not stop the loop');
    });
    const recovery = agent.recover({ intervalMs: 10, onError });
    loops.push(recovery);
    await vi.waitFor(() => expect(onError.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('process died') }), expect.objectContaining({ sessionId: 'job-bad' }));
    await recovery.stop();
  });

  it('throws without a listable checkpoint store, or with a bad interval', () => {
    expect(() => createAgent({ provider: mockModel(['x']) }).recover()).toThrow(expect.objectContaining({ code: 'LOUSHO_CONFIG_MISSING_CHECKPOINT_STORE' }));
    expect(() => createAgent({ provider: mockModel(['x']), store: memoryStore() }).recover({ intervalMs: 0 })).toThrow(expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID' }));
  });
});
