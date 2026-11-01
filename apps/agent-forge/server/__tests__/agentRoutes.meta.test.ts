/**
 * Agent routes v2 - `PATCH /agents/:id/meta`: the enable/disable
 * transitions, label normalisation and the 400/404 guards
 * (routes/agentRoutes.ts). Meta changes never write a version.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import type { AgentStore } from '../../src/persistence/AgentStore';
import { AgentRepo } from '../storage/agentRepo';
import type { AgentMeta, VersionListItem } from '../../shared/wireTypes';

describe('PATCH /agents/:id/meta', () => {
  let baseDir: string;
  let agentStore: AgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d06b-meta-'));
    agentStore = createFsAgentStore(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
    });
    repo = new AgentRepo(baseDir);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const app = () => createApp({ agentStore, runManager, baseDir });
  const patch = (id: string, body: object) => request(app()).patch(`/agents/${id}/meta`).send(body);

  /** Creates 'ops' via POST /agents (its version 1 exists) and answers its meta. */
  const createOps = async (): Promise<AgentMeta> => {
    const res = await request(app()).post('/agents').send({ from: 'blank', name: 'ops' });
    expect(res.status).toBe(201);
    return (res.body as { meta: AgentMeta }).meta;
  };

  it('enabled:false stamps disabledAt and disabledReason manual; enabled:true clears them and zeroes failureStreak', async () => {
    const meta = await createOps();
    // An auto-disabled streak the manual re-enable must clear.
    await repo.writeMeta('ops', {
      ...meta,
      enabled: false,
      disabledAt: '2026-01-01T00:00:00.000Z',
      disabledReason: 'auto_failure_streak',
      failureStreak: 5,
    });

    const on = await patch('ops', { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, disabledAt: null, disabledReason: null, failureStreak: 0 });

    const off = await patch('ops', { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    expect(off.body.disabledReason).toBe('manual');
    expect(typeof off.body.disabledAt).toBe('string');
    expect(off.body.disabledAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it("stores ['ops', 'billing'] for labels [' Ops ', 'ops', 'Billing'] and bumps updatedAt", async () => {
    const meta = await createOps();
    const res = await patch('ops', { labels: [' Ops ', 'ops', 'Billing'] });
    expect(res.status).toBe(200);
    expect(res.body.labels).toEqual(['ops', 'billing']);
    expect(Date.parse(res.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(meta.updatedAt));
    expect((await repo.readMeta('ops')).labels).toEqual(['ops', 'billing']);
  });

  it('400s LOUSHO_LABELS_INVALID for 21 labels and for a label over 32 chars, with the caps in details', async () => {
    await createOps();
    const many = await patch('ops', { labels: Array.from({ length: 21 }, (_, index) => `l${index}`) });
    expect(many.status).toBe(400);
    expect(many.body.code).toBe('LOUSHO_LABELS_INVALID');
    expect(many.body.details).toEqual({ maxLabels: 20, maxLength: 32 });

    const long = await patch('ops', { labels: ['x'.repeat(33)] });
    expect(long.status).toBe(400);
    expect(long.body.code).toBe('LOUSHO_LABELS_INVALID');
    expect((await repo.readMeta('ops')).labels).toEqual([]);
  });

  it.each([[{}], [{ enabled: 'yes' }], [{ labels: 'ops' }], [{ labels: [1] }]])(
    '400s LOUSHO_BODY_INVALID for %j',
    async (body) => {
      await createOps();
      const res = await patch('ops', body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LOUSHO_BODY_INVALID');
    }
  );

  it('404s LOUSHO_AGENT_NOT_FOUND for an unknown agent', async () => {
    const res = await patch('ghost', { enabled: false });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No saved agent 'ghost'", code: 'LOUSHO_AGENT_NOT_FOUND' });
  });

  it('never writes a version for a meta-only change', async () => {
    await createOps();
    await patch('ops', { enabled: false });
    await patch('ops', { labels: ['ops'] });
    const versions = (await request(app()).get('/agents/ops/versions')).body as VersionListItem[];
    expect(versions).toHaveLength(1);
    expect(versions[0].kind).toBe('create');
  });
});
