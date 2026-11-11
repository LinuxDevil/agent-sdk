import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import { SpendLog } from '../passes/spendLog';
import type { PassRecord } from '../passes/passRunner';

function record(over: Partial<PassRecord> = {}): PassRecord {
  return {
    kind: 'version_summary',
    key: 'k',
    workspaceId: 'ws-1',
    agentId: 'a1',
    model: null,
    outcome: 'completed',
    usage: null,
    costUsd: null,
    ms: 5,
    at: '2026-10-10T12:00:00.000Z',
    ...over,
  };
}

/** `GET /settings/passes/spend` over a temp spend log wired through createApp. */
describe('pass spend route', () => {
  let baseDir: string;
  let spendFile: string;
  let spendLog: SpendLog;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-pass-routes-'));
    spendFile = path.join(baseDir, 'spend.jsonl');
    spendLog = new SpendLog(spendFile);
    agentStore = createFsAgentStore(baseDir);
    const repo = new AgentRepo(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const app = () => createApp({ agentStore, runManager, baseDir, spendLog });

  it('summarizes a month: total cost, call count, per-kind breakdown', async () => {
    await spendLog.append(record({ costUsd: 0.4 }));
    await spendLog.append(record({ kind: 'eval_judge', costUsd: 0.1, at: '2026-10-20T00:00:00.000Z' }));
    await spendLog.append(record({ costUsd: null, at: '2026-11-01T00:00:00.000Z' }));
    const res = await request(app()).get('/settings/passes/spend?month=2026-10');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      month: '2026-10',
      totalUsd: 0.5,
      calls: 2,
      byKind: {
        version_summary: { calls: 1, costUsd: 0.4 },
        eval_judge: { calls: 1, costUsd: 0.1 },
      },
    });
  });

  it('defaults to the current UTC month', async () => {
    const thisMonth = new Date().toISOString().slice(0, 7);
    await spendLog.append(record({ at: `${thisMonth}-15T00:00:00.000Z`, costUsd: 1 }));
    const res = await request(app()).get('/settings/passes/spend');
    expect(res.status).toBe(200);
    expect(res.body.month).toBe(thisMonth);
    expect(res.body.calls).toBe(1);
  });

  it('400s on a malformed month', async () => {
    const res = await request(app()).get('/settings/passes/spend?month=October');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'month must look like 2026-10' });
  });
});
