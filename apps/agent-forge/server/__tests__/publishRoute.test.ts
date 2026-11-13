import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import type { AgentRecord } from '../../shared/wireTypes';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { SecretsStore } from '../secretsStore';
import { studioPathsFor } from '../workspace/studioPaths';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';

const SPEC_A: AgentSpecV2 = { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Check the queues.' };
const SPEC_B: AgentSpecV2 = { ...SPEC_A, description: 'Second draft.' };

describe('POST /agents/:id/publish', () => {
  let baseDir: string;
  let studioHome: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l14a-publish-route-'));
    studioHome = path.join(baseDir, '.lousho');
    agentStore = createFsAgentStore(baseDir);
    repo = new AgentRepo(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    await repo.writeSpec('ops', SPEC_A);
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
    });

  const getRecord = async () => {
    const res = await request(app()).get('/agents/ops');
    expect(res.status).toBe(200);
    return res.body as AgentRecord;
  };

  it('publishes the working copy as a publish version and reports publishState', async () => {
    // v1 create, then a drifted working copy (no version captured yet).
    await request(app()).post('/agents/ops/versions').send({ source: 'editor' });
    await repo.writeSpec('ops', SPEC_B);
    const res = await request(app()).post('/agents/ops/publish').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publishedVersion: 2 });

    const record = await getRecord();
    expect(record.meta.publishedVersion).toBe(2);
    expect(record.publishState.version).toBe(2);
    expect(record.publishState.matchesWorkingCopy).toBe(true);
    expect(typeof record.publishState.publishedAt).toBe('string');

    // Drift the working copy: matchesWorkingCopy flips false, then back.
    await repo.writeSpec('ops', { ...SPEC_B, instructions: 'Changed.' });
    expect((await getRecord()).publishState.matchesWorkingCopy).toBe(false);
    await repo.writeSpec('ops', SPEC_B);
    expect((await getRecord()).publishState.matchesWorkingCopy).toBe(true);
  });

  it('pins an explicit version and treats repinning as a no-op', async () => {
    await request(app()).post('/agents/ops/versions').send({ source: 'editor' });
    await repo.writeSpec('ops', SPEC_B);
    await request(app()).post('/agents/ops/versions').send({ source: 'editor' });
    await repo.writeSpec('ops', SPEC_A);

    const res = await request(app()).post('/agents/ops/publish').send({ version: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publishedVersion: 1 });
    // Working copy (SPEC_A) matches v1's spec again.
    expect((await getRecord()).publishState.matchesWorkingCopy).toBe(true);

    const again = await request(app()).post('/agents/ops/publish').send({ version: 1 });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ publishedVersion: 1 });
    const versions = await request(app()).get('/agents/ops/versions');
    expect(versions.body).toHaveLength(2);
  });

  it('answers 404 for an unknown agent and an unknown version', async () => {
    const ghost = await request(app()).post('/agents/ghost/publish').send({});
    expect(ghost.status).toBe(404);
    expect(ghost.body.code).toBe('LOUSHO_AGENT_NOT_FOUND');

    const missing = await request(app()).post('/agents/ops/publish').send({ version: 9 });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('LOUSHO_VERSION_NOT_FOUND');
  });

  it.each([[0], [-1], [1.5], ['2'], [null]])('answers 400 for version=%j', async (version) => {
    const res = await request(app()).post('/agents/ops/publish').send({ version });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('version must be a positive integer');
  });

  it('GET /agents/:id reports an unpublished agent with a null publishState', async () => {
    const record = await getRecord();
    expect(record.publishState).toEqual({ version: null, matchesWorkingCopy: false, publishedAt: null });
  });
});
