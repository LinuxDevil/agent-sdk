import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { WebSocket } from 'ws';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import { startStudioServer, type StudioServerHandle } from '../index';
import { STUDIO_TOKEN_HEADER } from '../auth';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { StudioEventBus } from '../events/eventBus';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import type { StudioEvent, StreamMessage } from '../../shared/wireTypes';

const TOKEN = 'events-token-0123456789';

const V2_SPEC: AgentSpecV2 = {
  version: 2,
  name: 'ev-agent',
  model: 'mock/mock-1',
  instructions: 'Check the queues.',
};

/**
 * `WS /events` end to end: a real `startStudioServer` pushes the
 * `StudioEvent`s its routes publish to every connected tab, under the
 * same token gate as `WS /agents/:id/stream` - which keeps working off
 * the same single upgrade router.
 */
describe('WS /events (startStudioServer)', () => {
  let baseDir: string;
  let handle: StudioServerHandle;
  let origin: string;

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-events-'));
    handle = await startStudioServer({
      baseDir,
      port: 0,
      observe: false,
      judge: false,
      staticDir: false,
      token: TOKEN,
    });
    origin = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    await handle.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function wsUrl(path: string): string {
    return `ws://127.0.0.1:${handle.port}${path}`;
  }

  /** Awaits one StudioEvent matching `pred` from a list 'message' appends to. */
  async function waitForEvent(
    events: StudioEvent[],
    pred: (event: StudioEvent) => boolean,
    timeoutMs = 3000
  ): Promise<StudioEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = events.find(pred);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for a StudioEvent');
  }

  it('a client on /events?token receives agent.changed after a PUT /agents/:id', async () => {
    const ws = new WebSocket(wsUrl(`/events?token=${TOKEN}`));
    const events: StudioEvent[] = [];
    ws.on('message', (data) => events.push(JSON.parse(String(data)) as StudioEvent));
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      const res = await fetch(`${origin}/agents/ev-agent`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', [STUDIO_TOKEN_HEADER]: TOKEN },
        body: JSON.stringify({ spec: V2_SPEC }),
      });
      expect(res.status).toBe(204);
      const frame = await waitForEvent(
        events,
        (e) => e.type === 'agent.changed' && e.agentId === 'ev-agent'
      );
      expect(frame).toEqual({ type: 'agent.changed', agentId: 'ev-agent', reason: 'save' });
    } finally {
      ws.close();
    }
  });

  it('rejects /events without the token with 401, like the stream', async () => {
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl('/events'));
      ws.on('open', () => {
        ws.close();
        resolve(0);
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
    expect(status).toBe(401);
  });

  it('destroys an upgrade to a path no WS endpoint owns', async () => {
    const outcome = await new Promise<'open' | 'error' | number>((resolve) => {
      const ws = new WebSocket(wsUrl(`/other?token=${TOKEN}`));
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve('error'));
    });
    expect(outcome).toBe('error');
  });

  it('the agent stream still answers status on connect', async () => {
    const ws = new WebSocket(wsUrl(`/agents/ev-agent/stream?token=${TOKEN}`));
    const messages: StreamMessage[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data)) as StreamMessage));
    try {
      const status = await new Promise<Extract<StreamMessage, { type: 'status' }>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no status frame')), 3000);
        ws.on('message', (data) => {
          const message = JSON.parse(String(data)) as StreamMessage;
          if (message.type === 'status') {
            clearTimeout(timer);
            resolve(message);
          }
        });
        ws.on('error', reject);
      });
      expect(status.type).toBe('status');
      expect(status.payload.agentId).toBe('ev-agent');
    } finally {
      ws.close();
    }
  });
});

/**
 * Which routes publish which StudioEvents, asserted against an injected
 * bus on `createApp` (the `eventBus` test seam) rather than a real socket.
 */
describe('route publishes (injected eventBus)', () => {
  let baseDir: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;
  let events: StudioEvent[];
  let eventBus: StudioEventBus;

  const app = () =>
    createApp({ agentStore, runManager, baseDir, eventBus });

  const lastEvents = () => events.splice(0, events.length);

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d15-events-'));
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
    events = [];
    eventBus = new StudioEventBus();
    eventBus.subscribe((event) => events.push(event));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const putAgent = (id: string, spec: unknown = { ...V2_SPEC, name: id }) =>
    request(app()).put(`/agents/${id}`).send({ spec });

  it('PUT /agents/:id publishes agent.changed reason save', async () => {
    expect((await putAgent('a1')).status).toBe(204);
    expect(lastEvents()).toEqual([{ type: 'agent.changed', agentId: 'a1', reason: 'save' }]);
  });

  it('DELETE /agents/:id publishes agent.changed reason save', async () => {
    await putAgent('a1');
    lastEvents();
    expect((await request(app()).delete('/agents/a1')).status).toBe(204);
    expect(lastEvents()).toEqual([{ type: 'agent.changed', agentId: 'a1', reason: 'save' }]);
  });

  it('PATCH /agents/:id/meta publishes agent.changed reason meta', async () => {
    await putAgent('a1');
    lastEvents();
    expect((await request(app()).patch('/agents/a1/meta').send({ enabled: false })).status).toBe(200);
    expect(lastEvents()).toEqual([{ type: 'agent.changed', agentId: 'a1', reason: 'meta' }]);
  });

  it('POST /agents publishes agent.changed reason save for the new id', async () => {
    const res = await request(app()).post('/agents').send({ from: 'blank', name: 'Fresh One' });
    expect(res.status).toBe(201);
    expect(lastEvents()).toEqual([{ type: 'agent.changed', agentId: res.body.id, reason: 'save' }]);
  });

  it('POST /agents/:id/versions publishes agent.changed reason version when a version is written', async () => {
    await putAgent('a1');
    lastEvents();
    expect((await request(app()).post('/agents/a1/versions').send({})).status).toBe(201);
    expect(lastEvents()).toEqual([{ type: 'agent.changed', agentId: 'a1', reason: 'version' }]);
    // A no-op save (nothing changed since the version) publishes nothing.
    expect((await request(app()).post('/agents/a1/versions').send({})).status).toBe(200);
    expect(lastEvents()).toEqual([]);
  });

  it('POST /agents/:id/versions/:n/restore publishes agent.changed reason restore', async () => {
    await putAgent('a1');
    await request(app()).post('/agents/a1/versions').send({});
    await putAgent('a1', { ...V2_SPEC, name: 'a1', description: 'changed' });
    lastEvents();
    expect((await request(app()).post('/agents/a1/versions/1/restore')).status).toBe(201);
    expect(lastEvents()).toEqual([{ type: 'agent.changed', agentId: 'a1', reason: 'restore' }]);
  });

  const draftBody = (description: string) => ({ patch: { description }, origin: 'manual', reason: 'try it' });

  it('draft create/withdraw/approve/reject publish draft.changed (+ agent.changed draft on approve)', async () => {
    await putAgent('a1');
    lastEvents();

    // Create -> pending.
    const created = await request(app()).post('/agents/a1/draft').send(draftBody('Drafted'));
    expect(created.status).toBe(201);
    expect(lastEvents()).toEqual([
      { type: 'draft.changed', agentId: 'a1', draftId: created.body.id, status: 'pending' },
    ]);

    // Approve -> approved, plus the agent record changed.
    const approved = await request(app()).post('/agents/a1/draft/approve').send({});
    expect(approved.status).toBe(200);
    expect(lastEvents()).toEqual([
      { type: 'draft.changed', agentId: 'a1', draftId: created.body.id, status: 'approved' },
      { type: 'agent.changed', agentId: 'a1', reason: 'draft' },
    ]);

    // Create + reject -> rejected.
    const second = await request(app()).post('/agents/a1/draft').send(draftBody('Drafted again'));
    expect(second.status).toBe(201);
    lastEvents();
    const rejected = await request(app()).post('/agents/a1/draft/reject').send({});
    expect(rejected.status).toBe(200);
    expect(lastEvents()).toEqual([
      { type: 'draft.changed', agentId: 'a1', draftId: second.body.id, status: 'rejected' },
    ]);

    // Create + withdraw -> withdrawn.
    const third = await request(app()).post('/agents/a1/draft').send(draftBody('Drafted thrice'));
    expect(third.status).toBe(201);
    lastEvents();
    const withdrawn = await request(app()).delete('/agents/a1/draft');
    expect(withdrawn.status).toBe(200);
    expect(lastEvents()).toEqual([
      { type: 'draft.changed', agentId: 'a1', draftId: third.body.id, status: 'withdrawn' },
    ]);
  });
});
