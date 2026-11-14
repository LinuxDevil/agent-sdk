/**
 * T06 - `POST /agents/:id/abort` and `RunManager.abort()`:
 *
 *  - a running agent run aborts to `status: 'stopped'` with
 *    `abortReason: 'user'` (the default) at the next model-call boundary;
 *  - a run paused on an approval is marked `stopped`, its pause file is
 *    deleted by the host's abort, and a later approve() 409s;
 *  - a caller-supplied reason ('abort_listener:<id>') lands on
 *    `abortReason` and is cleared by the next launch;
 *  - a flow run aborts to `stopped`, never `error`;
 *  - abort on an idle agent is a 202 no-op, and a malformed `reason` is a
 *    400 `LOUSHO_BODY_INVALID`.
 *
 * The 'mock' provider is replaced (LLMProviderRegistry.register wins over
 * the built-in) with a gated wrapper around the real MockLLMProvider so a
 * test can hold the run inside its first model call until the abort lands.
 * Vitest isolates this file's module graph, so the registration cannot
 * leak into other test files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import request from 'supertest';
import {
  LLMProviderRegistry,
  createMockProvider,
  upgradeSpec,
  type AgentSpecV2,
  type GenerateOptions,
  type LLMProvider,
} from '@linuxdevil/lousho';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';

// ---------------------------------------------------------------------------
// Gated mock provider
// ---------------------------------------------------------------------------

const gate = {
  /** While true, every model call parks inside the provider until release(). */
  hold: false,
  /** Model calls that have entered the gate (poll this to know the run is mid-flight). */
  calls: 0,
  waiters: [] as Array<() => void>,
};

/** Parks until `releaseGate()`; never rejects on abort - the SDK's own post-call signal check ends the run 'aborted'. */
function maybeGate(): Promise<void> {
  if (!gate.hold) return Promise.resolve();
  return new Promise((resolve) => gate.waiters.push(resolve));
}

function releaseGate(): void {
  gate.hold = false;
  gate.waiters.splice(0).forEach((resolve) => resolve());
}

class GatedMockProvider implements LLMProvider {
  readonly name = 'mock';
  private readonly inner = createMockProvider({ name: 'mock' });

  async generate(options: GenerateOptions) {
    gate.calls += 1;
    await maybeGate();
    return this.inner.generate(options);
  }

  async stream(options: GenerateOptions) {
    gate.calls += 1;
    await maybeGate();
    return this.inner.stream(options);
  }

  supportsTools(model: string): boolean {
    return this.inner.supportsTools(model);
  }

  supportsStreaming(model: string): boolean {
    return this.inner.supportsStreaming(model);
  }

  getModels(): Promise<string[]> {
    return this.inner.getModels();
  }
}

LLMProviderRegistry.register('mock', () => new GatedMockProvider());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A spec v2 whose only model call is gated - used for the running-abort tests. */
const SIMPLE_SPEC: AgentSpecV2 = {
  version: 2,
  name: 'abort-agent',
  model: 'mock/mock-1',
  instructions: 'You are a helpful agent.',
};

/** The same shape runRegistry.test.ts pauses on: an `ask` permission on current_date. */
const GATED_SPEC: AgentSpecV2 = {
  ...SIMPLE_SPEC,
  name: 'paused-agent',
  tools: [{ builtin: 'current_date' }],
  permissions: [{ id: 'p1', tool: 'current_date', action: 'ask' }],
};

/** A tiny branching flow (v1 shape, upgraded) whose llmCall step hits the gated provider. */
function flowSpec(): AgentSpecV2 {
  return upgradeSpec({
    name: 'flow-agent',
    prompt: 'classify this',
    provider: { type: 'mock', model: 'mock-1' },
    policy: {
      flow: {
        code: 'flow-agent',
        name: 'flow-agent',
        flow: {
          type: 'sequence',
          id: 'seq',
          steps: [
            { type: 'llmCall', id: 'llm', prompt: 'classify this', outputVariable: 'classify' },
            { type: 'end', id: 'end', value: 'done' },
          ],
        },
      },
    },
  });
}

function waitForStatus(
  runManager: RunManager,
  agentId: string,
  predicate: (status: { status: string }) => boolean,
  timeoutMs = 3000
): Promise<any> {
  const current = runManager.status(agentId);
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runManager.off('status', onStatus);
      reject(new Error(`Timed out waiting for status of '${agentId}'`));
    }, timeoutMs);
    function onStatus(payload: any) {
      if (payload.agentId !== agentId) return;
      if (predicate(payload)) {
        clearTimeout(timer);
        runManager.off('status', onStatus);
        resolve(payload);
      }
    }
    runManager.on('status', onStatus);
  });
}

async function waitForCalls(count: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (gate.calls < count) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${count} provider call(s)`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('POST /agents/:id/abort', () => {
  let baseDir: string;
  let app: ReturnType<typeof createApp>;
  let runManager: RunManager;
  let approvalStore: FileApprovalStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-n-abort-'));
    const repo = new AgentRepo(baseDir);
    approvalStore = new FileApprovalStore(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore,
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    app = createApp({ agentStore: createFsAgentStore(baseDir, repo), runManager, baseDir });
    gate.hold = false;
    gate.calls = 0;
    gate.waiters = [];
  });

  afterEach(() => {
    releaseGate();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('is a 202 no-op on an agent that never ran (and with no body at all)', async () => {
    const res = await request(app).post('/agents/never-ran/abort');
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('idle');
    expect(res.body.abortReason).toBeUndefined();
  });

  it.each([[{ reason: '' }], [{ reason: 42 }], [{ reason: 'x'.repeat(201) }]])(
    'rejects a malformed reason %j with 400 LOUSHO_BODY_INVALID',
    async (body) => {
      const res = await request(app).post('/agents/bad-reason/abort').send(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "'reason' must be 1 to 200 characters", code: 'LOUSHO_BODY_INVALID' });
    }
  );

  it('aborts a running agent run to stopped with abortReason \'user\'', async () => {
    gate.hold = true;
    const run = await request(app).post('/agents/run-agent/run').send({ spec: SIMPLE_SPEC, input: 'hello' });
    expect(run.status).toBe(202);
    await waitForCalls(1);
    expect(runManager.status('run-agent').status).toBe('running');

    const abort = await request(app).post('/agents/run-agent/abort').send({});
    expect(abort.status).toBe(202);

    releaseGate();
    const stopped = await waitForStatus(runManager, 'run-agent', (s) => s.status === 'stopped');
    expect(stopped.abortReason).toBe('user');

    const status = await request(app).get('/agents/run-agent/status');
    expect(status.body.status).toBe('stopped');
    expect(status.body.abortReason).toBe('user');
  });

  it('aborts a run paused on an approval: stopped, pause file deleted, approve 409s', async () => {
    const run = await request(app).post('/agents/paused-agent/run').send({ spec: GATED_SPEC, input: 'please use current_date' });
    expect(run.status).toBe(202);
    const paused = await waitForStatus(runManager, 'paused-agent', (s) => s.status === 'paused');
    expect(paused.pendingApproval?.toolName).toBe('current_date');
    const approvalId = paused.pendingApproval.approvalId as string;

    // The pause file exists before the abort (the pending-approval card reads it via peek()).
    const approvalsDir = path.join(baseDir, '.lousho', 'agents', 'paused-agent', 'approvals');
    expect(fs.existsSync(path.join(approvalsDir, `${approvalId}.json`))).toBe(true);

    const abort = await request(app).post('/agents/paused-agent/abort').send({ reason: 'abort_listener:a1' });
    expect(abort.status).toBe(202);
    expect(abort.body.status).toBe('stopped');
    expect(abort.body.reason).toBeUndefined();
    expect(abort.body.pendingApproval).toBeUndefined();
    expect(abort.body.abortReason).toBe('abort_listener:a1');

    // resolveFor is delete-on-read: the host's abort discarded the pause file.
    expect(fs.existsSync(path.join(approvalsDir, `${approvalId}.json`))).toBe(false);

    const approve = await request(app)
      .post('/agents/paused-agent/approve')
      .send({ approvalId, approved: true });
    expect(approve.status).toBe(409);
  });

  it('clears abortReason on the next launch', async () => {
    // Abort a RUNNING run (a paused run's durable checkpoint keeps its own
    // awaiting-approval record - aborting one is covered above; relaunching
    // it is a separate, pre-existing session-resume concern).
    gate.hold = true;
    await request(app).post('/agents/reason-agent/run').send({ spec: GATED_SPEC, input: 'please use current_date' }).expect(202);
    await waitForCalls(1);

    await request(app).post('/agents/reason-agent/abort').send({ reason: 'abort_listener:a1' }).expect(202);
    releaseGate();
    const stopped = await waitForStatus(runManager, 'reason-agent', (s) => s.status === 'stopped');
    expect(stopped.abortReason).toBe('abort_listener:a1');

    // The next launch (spec was persisted by the first run's saveSpec, so
    // no body spec is needed) clears the reason: the resumed run pauses on
    // the same approval again with no abortReason anywhere.
    await request(app).post('/agents/reason-agent/run').send({ input: 'please use current_date' }).expect(202);
    const relaunched = await waitForStatus(runManager, 'reason-agent', (s) => s.status === 'paused');
    expect(relaunched.abortReason).toBeUndefined();
    const internals = runManager as unknown as { entries: Map<string, { abortReason?: string }> };
    expect(internals.entries.get('reason-agent')?.abortReason).toBeUndefined();

    // Leave nothing paused behind for the next test's tempdir cleanup.
    await request(app).post('/agents/reason-agent/abort').send({});
  });

  it('aborts a flow run to stopped, not error', async () => {
    gate.hold = true;
    // RunManager-level: the flow spec goes through upgradeSpec'd v1 -> v2,
    // same as runRegistry.test.ts's branching-graph fixture.
    const spec = flowSpec();
    await runManager.run('flow-agent', 'unused for a flow run', spec);
    await waitForCalls(1);
    expect(runManager.status('flow-agent').status).toBe('running');

    await runManager.abort('flow-agent', 'user');
    releaseGate();
    const stopped = await waitForStatus(runManager, 'flow-agent', (s) => s.status === 'stopped' || s.status === 'error');
    expect(stopped.status).toBe('stopped');
    expect(stopped.abortReason).toBe('user');
    expect(stopped.error).toBeUndefined();
  });

  it('POST /agents/:id/stop still works and delegates to abort (paused run -> stopped)', async () => {
    await request(app).post('/agents/stop-agent/run').send({ spec: GATED_SPEC, input: 'please use current_date' }).expect(202);
    await waitForStatus(runManager, 'stop-agent', (s) => s.status === 'paused');

    const res = await request(app).post('/agents/stop-agent/stop');
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('stopped');
    expect(res.body.abortReason).toBe('user');
  });
});
