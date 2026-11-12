import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpec } from 'lousho';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import type { DraftView } from '../../shared/wireTypes';

const V1_SPEC: AgentSpec = {
  name: 'ops',
  prompt: 'Check the queues.',
  provider: { type: 'mock', model: 'mock-1' },
};

/**
 * `GET /agents/:id/draft` as a `DraftView` (L11b): the pending draft plus
 * `changes` (the patch diffed over the *current* working copy, not the
 * draft's base) and `currentVersion` (the latest version number, 0 when
 * the agent has none) - what the Suggestions tab's drift banner reads.
 */
describe('draft view', () => {
  let baseDir: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l11b-draftview-'));
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

  const app = () => createApp({ agentStore, runManager, baseDir });

  const saveAgent = async (id = 'ops', spec: AgentSpec = V1_SPEC) => {
    const res = await request(app()).put(`/agents/${id}`).send(spec);
    expect(res.status).toBe(204);
  };

  const createDraft = (id = 'ops', body: object = { patch: { description: 'Triage faster.' }, origin: 'author', reason: 'Tighter.' }) =>
    request(app()).post(`/agents/${id}/draft`).send(body);

  it('GET returns 204 when no draft is pending and 404 for an unknown agent', async () => {
    await saveAgent();
    expect((await request(app()).get('/agents/ops/draft')).status).toBe(204);
    expect((await request(app()).get('/agents/ghost/draft')).status).toBe(404);
  });

  it('GET includes the draft fields plus changes and currentVersion', async () => {
    await saveAgent();
    const created = (await createDraft()).body as DraftView;
    const res = await request(app()).get('/agents/ops/draft');
    expect(res.status).toBe(200);
    const view = res.body as DraftView;
    expect(view).toMatchObject({
      id: created.id,
      agentId: 'ops',
      status: 'pending',
      origin: 'author',
      reason: 'Tighter.',
      patch: { description: 'Triage faster.' },
      currentVersion: 0,
    });
    // The patch's diff over the working copy: description added.
    expect(view.changes).toHaveLength(1);
    expect(view.changes[0]).toMatchObject({ field: 'description', op: 'add', after: 'Triage faster.' });
  });

  it('changes diff against the current working copy, not the draft base', async () => {
    await saveAgent();
    await createDraft('ops', { patch: { description: 'Draft text.' }, origin: 'author', reason: 'x' });
    // The working copy moves on (a hand edit) before the GET.
    const spec = await repo.readSpec('ops');
    await repo.writeSpec('ops', { ...spec!, description: 'Edited outside.' });
    const view = (await request(app()).get('/agents/ops/draft')).body as DraftView;
    const description = view.changes.find((c) => c.field === 'description');
    // before = today's working copy, after = working copy + patch.
    expect(description?.before).toBe('Edited outside.');
    expect(description?.after).toBe('Draft text.');
  });

  it('currentVersion is the latest version number (drift input for the banner)', async () => {
    await saveAgent();
    expect((await request(app()).post('/agents/ops/versions').send({})).status).toBe(201);
    // A real edit so the second save is not the store's no-op update.
    await saveAgent('ops', { ...V1_SPEC, prompt: 'Check the queues, twice.' });
    expect((await request(app()).post('/agents/ops/versions').send({})).status).toBe(201);
    await createDraft();
    const view = (await request(app()).get('/agents/ops/draft')).body as DraftView;
    expect(view.currentVersion).toBe(2);
    // The draft was made against v2, so there is no drift yet.
    expect(view.baseVersion).toBe(2);
  });
});
