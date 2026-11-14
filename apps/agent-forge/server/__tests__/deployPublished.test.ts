/**
 * X05: `POST /agents/:id/deploy` builds the PUBLISHED snapshot - the pinned
 * version's spec written to `.lousho/agents/<id>/published.yaml` - never the
 * working copy. `node:child_process`'s `spawn` is mocked so no real
 * `lousho build` ever runs; the mock still asserts the `--agent=` file
 * exists at spawn time, like a real build would require.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import request from 'supertest';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { SecretsStore } from '../secretsStore';
import { studioPathsFor } from '../workspace/studioPaths';
import { publishedSpecPath } from '../deployRunner';
import type { DeployResult } from '../../shared/wireTypes';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});
import { spawn } from 'node:child_process';

const PUBLISHED_SPEC: AgentSpecV2 = {
  version: 2,
  name: 'ops',
  model: 'mock/mock-1',
  instructions: 'Published instructions.',
};
const WORKING_SPEC: AgentSpecV2 = { ...PUBLISHED_SPEC, instructions: 'Unpublished working-copy instructions.' };

/** The argv of the one child process `runDeploy` spawned. */
function spawnedArgs(): string[] {
  const calls = vi.mocked(spawn).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][1] as string[];
}

describe('POST /agents/:id/deploy (published version)', () => {
  let baseDir: string;
  let studioHome: string;
  let repo: AgentRepo;
  let app: () => ReturnType<typeof createApp>;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-x05-deploy-'));
    studioHome = path.join(baseDir, '.lousho');
    repo = new AgentRepo(baseDir);
    const agentStore = createFsAgentStore(baseDir);
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
    await repo.writeSpec('ops', PUBLISHED_SPEC);
    vi.mocked(spawn).mockImplementation((_command, args) => {
      const child = new EventEmitter() as ChildProcess;
      child.stdout = new EventEmitter() as ChildProcess['stdout'];
      child.stderr = new EventEmitter() as ChildProcess['stderr'];
      process.nextTick(() => child.emit('close', 0));
      // The published.yaml the build reads must exist at spawn time.
      const agentArg = (args as string[]).find((a) => a.startsWith('--agent='));
      expect(agentArg).toBeDefined();
      expect(fs.existsSync(agentArg!.slice('--agent='.length))).toBe(true);
      return child;
    });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    vi.mocked(spawn).mockReset();
  });

  const post = (id: string, body: unknown) => request(app()).post(`/agents/${id}/deploy`).send(body as object);

  it('answers 409 LOUSHO_NOT_PUBLISHED and spawns nothing for an unpublished agent', async () => {
    const res = await post('ops', { adapter: 'node-server' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'Publish a version before deploying', code: 'LOUSHO_NOT_PUBLISHED' });
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown agent and 400 for a bad adapter', async () => {
    const ghost = await post('ghost', { adapter: 'node-server' });
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toBe("No agent 'ghost'");

    const bad = await post('ops', { adapter: 'carrier-pigeon' });
    expect(bad.status).toBe(400);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('builds the published snapshot, not the drifted working copy, and reports the version', async () => {
    // Publish v1 (PUBLISHED_SPEC), then drift the working copy.
    const publish = await request(app()).post('/agents/ops/publish').send({});
    expect(publish.status).toBe(200);
    await repo.writeSpec('ops', WORKING_SPEC);

    const res = await post('ops', { adapter: 'node-server' });
    expect(res.status).toBe(200);
    const result = res.body as DeployResult;
    expect(result.version).toBe(1);
    expect(result.exitCode).toBe(0);

    const agentArg = spawnedArgs().find((a) => a.startsWith('--agent='))!.slice('--agent='.length);
    expect(agentArg).toBe(publishedSpecPath(baseDir, 'ops'));
    // The file deploy reads is the published snapshot's v1 projection -
    // PUBLISHED_SPEC's instructions, not the working copy's.
    const fed = parseYaml(fs.readFileSync(agentArg, 'utf8')) as Record<string, unknown>;
    expect(fed).toMatchObject({
      name: 'ops',
      prompt: 'Published instructions.',
      provider: { type: 'mock', model: 'mock-1' },
    });
    expect(fed['version']).toBeUndefined();
  });

  it('publishing v1 after v2 rewrites published.yaml to the older snapshot', async () => {
    // v1 = PUBLISHED_SPEC (the beforeEach working copy), v2 = new draft.
    await request(app()).post('/agents/ops/publish').send({});
    await repo.writeSpec('ops', { ...PUBLISHED_SPEC, instructions: 'Version two instructions.' });
    await request(app()).post('/agents/ops/versions').send({ source: 'editor' }); // v2
    await request(app()).post('/agents/ops/publish').send({ version: 2 });

    let fed = parseYaml(fs.readFileSync(publishedSpecPath(baseDir, 'ops'), 'utf8')) as Record<string, unknown>;
    expect(fed['prompt']).toBe('Version two instructions.');

    await request(app()).post('/agents/ops/publish').send({ version: 1 });
    fed = parseYaml(fs.readFileSync(publishedSpecPath(baseDir, 'ops'), 'utf8')) as Record<string, unknown>;
    expect(fed['prompt']).toBe('Published instructions.');
  });
});
