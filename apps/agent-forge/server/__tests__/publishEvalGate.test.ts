import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import type { EvalGateResult } from '../../shared/wireTypes';
import type { EvalGateDeps } from '../evals/gateRunner';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { SecretsStore } from '../secretsStore';
import { AlertStore } from '../inbox/alertStore';
import { studioPathsFor } from '../workspace/studioPaths';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'ops',
  model: 'mock/mock-1',
  instructions: 'Check the queues.',
  evals: [{ dataset: 'ops-regressions', gates: [{ maxSteps: 5 }], minPassRate: 0.8 }],
};

const PLAIN_SPEC: AgentSpecV2 = { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Check the queues.' };

const PASS_RESULT: EvalGateResult = {
  passed: true,
  gates: [
    {
      dataset: 'ops-regressions',
      passRate: 1,
      minPassRate: 0.8,
      passed: true,
      examples: [{ exampleId: 'e1', passed: true, failures: [] }],
    },
  ],
  ranAt: '2026-01-02T03:04:05.000Z',
};

const FAIL_RESULT: EvalGateResult = {
  passed: false,
  gates: [
    {
      dataset: 'ops-regressions',
      passRate: 0.5,
      minPassRate: 0.8,
      passed: false,
      examples: [
        { exampleId: 'e1', passed: true, failures: [] },
        { exampleId: 'e2', passed: false, failures: ['Took 9 steps, limit 5'], traceId: 'trace-9' },
      ],
    },
  ],
  ranAt: '2026-01-02T03:04:05.000Z',
};

describe('POST /agents/:id/publish eval gate (X01b)', () => {
  let baseDir: string;
  let studioHome: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;
  let alerts: AlertStore;
  let runGates: Mock<[AgentSpecV2, EvalGateDeps], Promise<EvalGateResult>>;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-x01b-publish-'));
    studioHome = path.join(baseDir, '.lousho');
    agentStore = createFsAgentStore(baseDir);
    repo = new AgentRepo(baseDir);
    alerts = new AlertStore(path.join(baseDir, 'alerts.json'));
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    runGates = vi.fn<[AgentSpecV2, EvalGateDeps], Promise<EvalGateResult>>(async () => PASS_RESULT);
    await repo.writeSpec('ops', SPEC);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const app = () =>
    createApp({
      agentStore,
      runManager,
      baseDir,
      studioHome,
      secretsStore: new SecretsStore(studioPathsFor(studioHome)),
      alerts,
      evalGateRunner: runGates,
    });

  const publishedVersion = async () => (await repo.readMeta('ops')).publishedVersion;

  it('runs the gate and answers 200 with evalResult when it passes', async () => {
    const res = await request(app()).post('/agents/ops/publish').send({});
    expect(res.status).toBe(200);
    expect(res.body.publishedVersion).toBe(1);
    expect(res.body.evalResult).toEqual(PASS_RESULT);
    expect(runGates).toHaveBeenCalledTimes(1);
    expect(runGates.mock.calls[0][0].evals).toHaveLength(1);
    expect(await publishedVersion()).toBe(1);
  });

  it('answers 409 with the full result, keeps the pointer and alerts on failure', async () => {
    runGates.mockResolvedValue(FAIL_RESULT);
    const res = await request(app()).post('/agents/ops/publish').send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'Eval gate failed',
      code: 'LOUSHO_EVAL_GATE_FAILED',
      version: 1,
      details: FAIL_RESULT,
    });
    // The captured publish version exists but nothing is pinned.
    expect(await publishedVersion()).toBeNull();
    const list = await alerts.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      kind: 'publish_failed',
      agentId: 'ops',
      title: 'Publish of v1 blocked by evals',
      detail: '1 of 1 eval sets below the required pass rate',
    });
    expect((list[0].payload as { version: number }).version).toBe(1);
  });

  it('answers 409 LOUSHO_EVAL_GATE_BUSY while a gate run is in flight', async () => {
    let release: ((result: EvalGateResult) => void) | undefined;
    runGates.mockReturnValue(new Promise<EvalGateResult>((resolve) => (release = resolve)));
    // supertest fires on await - the async wrapper starts the first publish now.
    const first = (async () => request(app()).post('/agents/ops/publish').send({}))();
    // Let the first publish reach the gate before the second arrives.
    await vi.waitFor(() => expect(runGates).toHaveBeenCalledTimes(1));
    const second = await request(app()).post('/agents/ops/publish').send({});
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'Evals are already running for this agent', code: 'LOUSHO_EVAL_GATE_BUSY' });
    release?.(PASS_RESULT);
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    expect(firstRes.body.publishedVersion).toBe(1);
  });

  it('skips the gate entirely for a spec without evals', async () => {
    await repo.writeSpec('ops', PLAIN_SPEC);
    const res = await request(app()).post('/agents/ops/publish').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publishedVersion: 1 });
    expect(runGates).not.toHaveBeenCalled();
  });

  it('does not re-run the gate when repinning the published version', async () => {
    await request(app()).post('/agents/ops/publish').send({});
    runGates.mockClear();
    const res = await request(app()).post('/agents/ops/publish').send({ version: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publishedVersion: 1 });
    expect(runGates).not.toHaveBeenCalled();
  });
});
