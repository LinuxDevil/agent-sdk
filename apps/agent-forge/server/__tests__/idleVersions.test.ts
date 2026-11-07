import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpec } from 'lousho';
import { createApp } from '../app';
import { startStudioServer } from '../index';
import { STUDIO_TOKEN_HEADER } from '../auth';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { VersionStore } from '../storage/versionStore';
import { IdleVersioner, createIdleVersioner } from '../storage/idleVersioner';
import type { VersionListItem } from '../../shared/wireTypes';

const V1_SPEC: AgentSpec = {
  name: 'ops',
  prompt: 'Check the queues.',
  provider: { type: 'mock', model: 'mock-1' },
};

const V1_SPEC_EDITED: AgentSpec = {
  ...V1_SPEC,
  prompt: 'Check the queues faster.',
};

const V1_SPEC_THIRD: AgentSpec = {
  ...V1_SPEC,
  prompt: 'Check the queues hourly.',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The idle-version wiring: `PUT /agents/:id` (autosave) re-arms the
 * workspace's `IdleVersioner`, `POST /agents/:id/versions` and `DELETE`
 * cancel it, and `close()` flushes. `createApp`'s `idleVersioner` seam
 * injects one with `delayMs: 20` over a real VersionStore.
 */
describe('idle editor versions', () => {
  let baseDir: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d16-idle-'));
    agentStore = createFsAgentStore(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    repo = new AgentRepo(baseDir);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const app = () => createApp({ agentStore, runManager, baseDir, idleVersioner: createIdleVersioner(new VersionStore(repo), 50) });
  const put = (a: ReturnType<typeof app>, id: string, spec: AgentSpec) => request(a).put(`/agents/${id}`).send(spec);
  const listVersions = (a: ReturnType<typeof app>, id = 'ops') => request(a).get(`/agents/${id}/versions`);

  it('three autosaves inside the delay, then quiet -> exactly one editor version', async () => {
    const a = app();
    // Back-to-back PUTs each re-arm the timer - the gaps between them are
    // just request latency, well under the 50 ms delay.
    await put(a, 'ops', V1_SPEC).expect(204);
    await put(a, 'ops', V1_SPEC_EDITED).expect(204);
    await put(a, 'ops', V1_SPEC_THIRD).expect(204);
    await sleep(120);

    const list = await listVersions(a);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ version: 1, kind: 'create', source: 'editor' });
  });

  it('a second quiet window after more autosaves captures an update', async () => {
    const a = app();
    await put(a, 'ops', V1_SPEC).expect(204);
    await sleep(120);
    await put(a, 'ops', V1_SPEC_EDITED).expect(204);
    await sleep(120);

    const list = await listVersions(a);
    expect(list.body.map((item: VersionListItem) => item.version)).toEqual([2, 1]);
    expect(list.body[0]).toMatchObject({ version: 2, kind: 'update', source: 'editor' });
  });

  it('an idle capture over an unchanged working copy writes nothing (the store no-op)', async () => {
    const a = app();
    await put(a, 'ops', V1_SPEC).expect(204);
    await sleep(120); // the first idle timer captures v1
    // Same spec autosaved again: the next idle capture is a no-op update.
    await put(a, 'ops', V1_SPEC).expect(204);
    await sleep(120);

    const list = await listVersions(a);
    expect(list.body).toHaveLength(1);
  });

  it('no autosaves -> the idle timer never fires a capture', async () => {
    const a = app();
    const created = await request(a).post('/agents').send({ from: 'blank', name: 'Ops' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    await sleep(120);

    const list = await listVersions(a, id);
    // Only the POST's own version-1 'create' capture exists.
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ version: 1, kind: 'create' });
  });

  it('an explicit save cancels the pending idle capture - no second version', async () => {
    const a = app();
    await put(a, 'ops', V1_SPEC).expect(204);
    const saved = await request(a).post('/agents/ops/versions').send({ source: 'editor' });
    expect(saved.status).toBe(201);
    expect(saved.body.version).toBe(1);
    await sleep(120);

    const list = await listVersions(a);
    expect(list.body).toHaveLength(1);
  });

  it('DELETE cancels the pending idle capture', async () => {
    const a = app();
    await put(a, 'ops', V1_SPEC).expect(204);
    await request(a).delete('/agents/ops').expect(204);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sleep(120);
    // Had the timer fired, the capture would have logged
    // "[agent-forge] idle version for ops failed: No saved agent 'ops'".
    expect(warn.mock.calls.flat().join(' ')).not.toContain('idle version for ops failed');
    warn.mockRestore();
  });

  it('StudioServerHandle.close() flushes a pending idle capture', async () => {
    const captured: string[] = [];
    const token = 'idle-close-token';
    const handle = await startStudioServer({
      baseDir,
      port: 0,
      staticDir: false,
      observe: false,
      judge: false,
      token,
      idleVersioner: new IdleVersioner({
        delayMs: 3_600_000,
        capture: async (id) => {
          captured.push(id);
        },
      }),
    });
    try {
      const put = await request(handle.server).put('/agents/ops').set(STUDIO_TOKEN_HEADER, token).send(V1_SPEC);
      expect(put.status).toBe(204);
    } finally {
      await handle.close();
    }
    expect(captured).toEqual(['ops']);
  });
});
