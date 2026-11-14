/**
 * A08b `POST /agents/:id/eject`: writes the agent-directory form
 * (`specToAgentDir`) to `agents/<id>/` under the workspace root - 200 with
 * the written paths, 409 `LOUSHO_EJECT_EXISTS` when the folder exists,
 * `{ overwrite: true }` to replace, 404 for an unknown agent, 400 when a
 * generated path would escape the target folder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { specToAgentDir } from '@linuxdevil/lousho/spec';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { SecretsStore } from '../secretsStore';
import { studioPathsFor } from '../workspace/studioPaths';
import type { EjectResult } from '../../shared/wireTypes';
import type { AgentSpecV2 } from '@linuxdevil/lousho';

vi.mock('@linuxdevil/lousho/spec', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@linuxdevil/lousho/spec')>();
  return { ...mod, specToAgentDir: vi.fn(mod.specToAgentDir) };
});

const V2_SPEC: AgentSpecV2 = {
  version: 2,
  name: 'ops',
  model: 'mock/mock-1',
  instructions: 'Check the queues.',
};

describe('POST /agents/:id/eject', () => {
  let baseDir: string;
  let studioHome: string;
  let repo: AgentRepo;
  let app: () => ReturnType<typeof createApp>;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-a08b-eject-'));
    studioHome = path.join(baseDir, '.lousho');
    const agentStore = createFsAgentStore(baseDir);
    repo = new AgentRepo(baseDir);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    app = () =>
      createApp({
        agentStore,
        runManager,
        baseDir,
        studioHome,
        secretsStore: new SecretsStore(studioPathsFor(studioHome)),
      });
    await repo.writeSpec('x', V2_SPEC);
    vi.mocked(specToAgentDir).mockClear();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('writes agents/x/agent.yaml and returns the written paths', async () => {
    const res = await request(app()).post('/agents/x/eject').send({});
    expect(res.status).toBe(200);
    const body = res.body as EjectResult;
    expect(body.dir).toBe('agents/x');
    expect(body.files).toContain('agent.yaml');
    const written = path.join(baseDir, 'agents', 'x', 'agent.yaml');
    expect(fs.existsSync(written)).toBe(true);
    expect(fs.readFileSync(written, 'utf8')).toContain('ops');
  });

  it('answers 409 LOUSHO_EJECT_EXISTS with the existing files, then 200 on overwrite', async () => {
    await request(app()).post('/agents/x/eject').send({}).expect(200);
    const again = await request(app()).post('/agents/x/eject').send({});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('LOUSHO_EJECT_EXISTS');
    expect(again.body.error).toBe('agents/x/ already exists.');
    expect(again.body.details.files).toContain('agent.yaml');

    const overwrite = await request(app()).post('/agents/x/eject').send({ overwrite: true });
    expect(overwrite.status).toBe(200);
  });

  it('answers 404 for an unknown agent', async () => {
    const res = await request(app()).post('/agents/nope/eject').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Agent nope not found.');
  });

  it('answers 400 and writes nothing when a generated path escapes the target', async () => {
    vi.mocked(specToAgentDir).mockReturnValueOnce({
      files: [{ path: '../evil.ts', content: 'export {}' }],
      dropped: [],
    });
    const res = await request(app()).post('/agents/x/eject').send({ overwrite: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOUSHO_EJECT_INVALID');
    expect(fs.existsSync(path.join(baseDir, 'agents', 'evil.ts'))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, 'evil.ts'))).toBe(false);
  });

  it('answers 400 LOUSHO_EJECT_INVALID when specToAgentDir throws', async () => {
    vi.mocked(specToAgentDir).mockImplementationOnce(() => {
      throw new Error('spec cannot be a directory');
    });
    const res = await request(app()).post('/agents/x/eject').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOUSHO_EJECT_INVALID');
    expect(res.body.error).toBe('spec cannot be a directory');
  });
});
