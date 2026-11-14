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
import { SettingsStore } from '../settingsStore';
import { studioPathsFor } from '../workspace/studioPaths';

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
  let settingsStore: SettingsStore;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-pass-routes-'));
    spendFile = path.join(baseDir, 'spend.jsonl');
    spendLog = new SpendLog(spendFile);
    settingsStore = new SettingsStore(studioPathsFor(path.join(baseDir, '.lousho-studio')));
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

  const app = () => createApp({ agentStore, runManager, baseDir, spendLog, settingsStore });

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

describe('pass settings routes (L06b)', () => {
  let baseDir: string;
  let settingsStore: SettingsStore;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-pass-settings-'));
    settingsStore = new SettingsStore(studioPathsFor(path.join(baseDir, '.lousho-studio')));
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

  const app = () => createApp({ agentStore, runManager, baseDir, settingsStore });

  it('GET answers the defaults; PUT merges a patch and GET reflects it', async () => {
    const get = await request(app()).get('/settings/passes');
    expect(get.status).toBe(200);
    expect(get.body.model).toBe('anthropic/claude-haiku-5-5');
    expect(get.body.enabled.prompt_suggestion).toBe(true);

    const put = await request(app())
      .put('/settings/passes')
      .send({ model: 'openai/gpt-4o-mini', enabled: { prompt_suggestion: false } });
    expect(put.status).toBe(200);
    expect(put.body.model).toBe('openai/gpt-4o-mini');
    expect(put.body.enabled.prompt_suggestion).toBe(false);
    expect(put.body.enabled.eval_judge).toBe(true);

    const again = await request(app()).get('/settings/passes');
    expect(again.body).toEqual(put.body);
  });

  it('400s on a bad model and on an unknown or non-boolean enabled kind', async () => {
    const badModel = await request(app()).put('/settings/passes').send({ model: 'haiku' });
    expect(badModel.status).toBe(400);
    const unknownKind = await request(app()).put('/settings/passes').send({ enabled: { foo: true } });
    expect(unknownKind.status).toBe(400);
    const nonBoolean = await request(app()).put('/settings/passes').send({ enabled: { eval_judge: 'yes' } });
    expect(nonBoolean.status).toBe(400);
    // Nothing was written.
    const get = await request(app()).get('/settings/passes');
    expect(get.body.model).toBe('anthropic/claude-haiku-5-5');
  });
});
