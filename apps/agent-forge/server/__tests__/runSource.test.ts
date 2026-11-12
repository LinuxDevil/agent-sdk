import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentSpecV2 } from 'lousho';
import type { AgentRunStatusPayload, RunStatus } from '../../shared/wireTypes';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'source-agent',
  model: 'mock/mock-1',
  instructions: 'You are a helpful agent.',
  tools: [{ builtin: 'current_date' }],
};

const TERMINAL: RunStatus[] = ['done', 'error', 'stopped'];

/**
 * The NEXT run's terminal status. sendMessage() re-emits the previous
 * run's 'done' status when it queues the user message, so this resolves
 * only on a terminal status seen AFTER a 'running' for the new run -
 * registering a terminal waiter up front would resolve on the stale one.
 */
function waitForNextTerminal(runManager: RunManager, agentId: string): Promise<AgentRunStatusPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runManager.off('status', onStatus);
      reject(new Error('Timed out waiting for run status'));
    }, 5000);
    let sawRunning = false;
    function onStatus(payload: AgentRunStatusPayload) {
      if (payload.agentId !== agentId) return;
      if (payload.status === 'running') sawRunning = true;
      if (!sawRunning || !TERMINAL.includes(payload.status)) return;
      clearTimeout(timer);
      runManager.off('status', onStatus);
      resolve(payload);
    }
    runManager.on('status', onStatus);
  });
}

describe('run source (L12)', () => {
  let baseDir: string;
  let runManager: RunManager;
  let statuses: AgentRunStatusPayload[];

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l12-source-'));
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: async () => undefined,
      saveSpec: async () => {},
    });
    statuses = [];
    runManager.on('status', (payload: AgentRunStatusPayload) => statuses.push(payload));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("run(..., { source: 'trigger', triggerId }) puts both on the status payload", async () => {
    const settled = waitForNextTerminal(runManager, 'a1');
    await runManager.run('a1', 'hi', SPEC, { source: 'trigger', triggerId: 't1' });
    const terminal = await settled;
    expect(terminal.source).toBe('trigger');
    expect(terminal.triggerId).toBe('t1');
    const launched = statuses.find((s) => s.agentId === 'a1' && s.status === 'running');
    expect(launched?.source).toBe('trigger');
    expect(launched?.triggerId).toBe('t1');
  });

  it('a later manual run clears source and triggerId', async () => {
    let settled = waitForNextTerminal(runManager, 'a1');
    await runManager.run('a1', 'hi', SPEC, { source: 'trigger', triggerId: 't1' });
    await settled;

    settled = waitForNextTerminal(runManager, 'a1');
    await runManager.run('a1', 'again', SPEC);
    const terminal = await settled;
    expect(terminal.source).toBeUndefined();
    expect(terminal.triggerId).toBeUndefined();
  });

  it('sendMessage stays manual even after a triggered run', async () => {
    let settled = waitForNextTerminal(runManager, 'a1');
    await runManager.run('a1', 'hi', SPEC, { source: 'trigger', triggerId: 't1' });
    await settled;

    settled = waitForNextTerminal(runManager, 'a1');
    await runManager.sendMessage('a1', 'a chat turn', SPEC);
    const terminal = await settled;
    expect(terminal.source).toBeUndefined();
    expect(terminal.triggerId).toBeUndefined();
  });
});
