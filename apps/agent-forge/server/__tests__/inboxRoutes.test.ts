import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpec } from '@linuxdevil/lousho';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { DraftStore } from '../storage/draftStore';
import { SuggestionStore } from '../storage/suggestionStore';
import { AlertStore } from '../inbox/alertStore';
import { WorkspaceRegistry } from '../workspace/workspaceRegistry';
import type { InboxService } from '../inbox/inboxService';
import type { InboxItem, PromptSuggestion } from '../../shared/wireTypes';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import { workspaceIdFor } from '../workspace/workspaceId';

const V1_SPEC: AgentSpec = {
  name: 'ops',
  prompt: 'Check the queues.',
  provider: { type: 'mock', model: 'mock-1' },
};

function promptSuggestion(agentId: string, over: Partial<PromptSuggestion> = {}): PromptSuggestion {
  return {
    kind: 'prompt_edit',
    id: 'sug1',
    agentId,
    sourceTraceId: 't1',
    expectedPromptHash: 'p1',
    proposedPromptHash: 'p2',
    oldText: 'a',
    newText: 'b',
    confidence: 'low',
    optimizationClass: 'Missing operational fact',
    evidence: 'e',
    expectedSaving: 'one fewer round trip',
    risk: 'low',
    validationPlan: [],
    status: 'open',
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    resolvedAt: null,
    appliedVersion: null,
    ...over,
  };
}

describe('inbox routes', () => {
  let baseDir: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;
  let alerts: AlertStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-r02a-inbox-'));
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
    alerts = new AlertStore(path.join(baseDir, '.lousho', 'inbox', 'alerts.json'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const app = (inbox?: InboxService) => createApp({ agentStore, runManager, baseDir, alerts, ...(inbox ? { inbox } : {}) });

  const saveAgent = async (id = 'ops') => {
    const res = await request(app()).put(`/agents/${id}`).send(V1_SPEC);
    expect(res.status).toBe(204);
  };

  it('GET /inbox requires the studio token', async () => {
    const secured = createApp({ agentStore, runManager, baseDir, alerts, access: { token: 'tok' } });
    expect((await request(secured).get('/inbox')).status).toBe(401);
    expect((await request(secured).get('/inbox').set('x-lousho-studio-token', 'tok')).status).toBe(200);
  });

  it('GET /inbox lists pending drafts, open suggestions and alerts with the contract copy', async () => {
    await saveAgent();
    const draftRes = await request(app()).post('/agents/ops/draft').send({
      patch: { description: 'Tighter.' },
      origin: 'author',
      reason: 'The prompt rambles.',
    });
    expect(draftRes.status).toBe(201);
    await new SuggestionStore(repo).save('ops', promptSuggestion('ops'));
    const alert = await alerts.add({
      kind: 'auto_disabled',
      agentId: 'ops',
      workspaceId: workspaceIdFor(baseDir),
      title: 'ops was auto-disabled',
      detail: '5 triggered runs failed',
      payload: { failures: 5 },
    });

    const res = await request(app()).get('/inbox');
    expect(res.status).toBe(200);
    const items = res.body as InboxItem[];
    expect(items).toHaveLength(3);
    const byKind = new Map(items.map((item) => [item.kind, item]));
    expect(byKind.get('draft')).toMatchObject({
      id: expect.stringMatching(/^draft:ops:/),
      agentId: 'ops',
      agentName: 'ops',
      title: 'Pending change',
      detail: 'The prompt rambles.',
      origin: 'author',
      gated: false,
    });
    expect(byKind.get('suggestion')).toMatchObject({
      id: 'suggestion:ops:sug1',
      title: 'Prompt suggestion',
      detail: 'one fewer round trip',
      confidence: 'low',
    });
    expect(byKind.get('alert')).toMatchObject({
      id: `alert:ops:${alert.id}`,
      alertKind: 'auto_disabled',
      title: 'ops was auto-disabled',
      detail: '5 triggered runs failed',
    });
  });

  it('GET /inbox/count returns the same number and drops on dismiss', async () => {
    await saveAgent();
    await new SuggestionStore(repo).save('ops', promptSuggestion('ops'));
    await new DraftStore(repo).create('ops', {
      patch: { description: 'x' },
      origin: 'manual',
      reason: 'r',
      baseVersion: null,
      baseSpecHash: 'h',
    });
    const wsId = workspaceIdFor(baseDir);
    const alert = await alerts.add({ kind: 'publish_failed', agentId: 'ops', workspaceId: wsId, title: 't', detail: null, payload: {} });

    expect((await request(app()).get('/inbox/count')).body).toEqual({ count: 3 });
    const dismissed = await request(app()).post(`/inbox/alerts/${alert.id}/dismiss`);
    expect(dismissed.status).toBe(204);
    expect((await request(app()).get('/inbox/count')).body).toEqual({ count: 2 });
    expect((await request(app()).get('/inbox')).body).toHaveLength(2);
  });

  it('POST /inbox/alerts/:alertId/dismiss answers 404 for an unknown id', async () => {
    const res = await request(app()).post('/inbox/alerts/alert_nope/dismiss');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No alert alert_nope');
  });

  it('GET /inbox?ws=all and /inbox/count?ws=all aggregate every registered workspace (W09a)', async () => {
    // A second workspace with a pending draft, registered but never
    // resolved - the aggregate reads its disk stores without building
    // a context (`warm: () => []` keeps even the launch folder cold).
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-r02a-other-'));
    try {
      const otherRepo = new AgentRepo(otherDir);
      await otherRepo.writeSpec('cold-one', { version: 2, name: 'Cold One', model: 'mock/mock-1', instructions: 'x' });
      await new DraftStore(otherRepo).create('cold-one', {
        patch: { description: 'x' },
        origin: 'manual',
        reason: 'cold reason',
        baseVersion: null,
        baseSpecHash: 'h',
      });
      const registry = new WorkspaceRegistry(path.join(baseDir, '.lousho', 'workspaces.json'));
      const launchRef = await registry.ensure(baseDir);
      const otherRef = await registry.ensure(otherDir);
      const aggregateApp = createApp({
        agentStore,
        runManager,
        baseDir,
        alerts,
        workspaceRegistry: registry,
        warm: () => [],
      });

      const res = await request(aggregateApp).get('/inbox?ws=all');
      expect(res.status).toBe(200);
      const items = res.body as InboxItem[];
      const cold = items.find((item) => item.agentId === 'cold-one');
      expect(cold).toMatchObject({ kind: 'draft', workspaceId: otherRef.id, agentName: 'Cold One', detail: 'cold reason' });
      // The launch workspace's own items carry its id too.
      expect(items.every((item) => item.workspaceId === launchRef.id || item.workspaceId === otherRef.id)).toBe(true);

      const count = await request(aggregateApp).get('/inbox/count?ws=all');
      expect(count.body).toEqual({ count: items.length });

      // The single-workspace routes are untouched.
      const single = await request(aggregateApp).get('/inbox');
      expect(single.status).toBe(200);
      expect((single.body as InboxItem[]).every((item) => item.workspaceId === launchRef.id)).toBe(true);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('an injected inbox stub serves /inbox* (the CreateAppOptions seam)', async () => {
    const item = {
      id: 'approval:ops:ap1',
      kind: 'approval',
      agentId: 'ops',
      workspaceId: 'ws',
      agentName: 'ops',
      title: 'Approve shell?',
      detail: '{}',
      at: '2026-01-01T00:00:00.000Z',
      approvalId: 'ap1',
      toolName: 'shell',
      args: {},
      expiresAt: null,
    } satisfies InboxItem;
    const inbox = {
      list: vi.fn(async () => [item]),
      count: vi.fn(async () => 1),
      dismissAlert: vi.fn(async () => true),
    } as unknown as InboxService;
    const server = app(inbox);
    expect((await request(server).get('/inbox')).body).toEqual([item]);
    expect((await request(server).get('/inbox/count')).body).toEqual({ count: 1 });
    expect((await request(server).post('/inbox/alerts/a1/dismiss')).status).toBe(204);
    expect(inbox.dismissAlert).toHaveBeenCalledWith('a1');
  });
});
