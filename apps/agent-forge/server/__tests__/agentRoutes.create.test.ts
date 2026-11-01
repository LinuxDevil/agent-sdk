/**
 * Agent routes v2 - `POST /agents` (blank and copy create),
 * `PATCH /agents/:id/meta` body handling shared with the meta suite,
 * and `PUT /agents/:id/layout` (routes/agentRoutes.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpecV2 } from 'lousho';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import type { AgentStore } from '../../src/persistence/AgentStore';
import { AgentRepo } from '../storage/agentRepo';
import type { AgentRecord, VersionListItem } from '../../shared/wireTypes';

const V2_SPEC: AgentSpecV2 = {
  version: 2,
  name: 'ops',
  description: 'Watches the queues.',
  model: 'mock/mock-1',
  instructions: 'Check the queues.',
};

const LAYOUT = {
  schemaVersion: 1,
  nodes: { agent: { x: 10, y: 20 }, 'tool:web': { x: 300, y: 20, collapsed: true } },
  notes: [{ id: 'n1', x: 0, y: 0, text: 'remember this' }],
  viewport: { x: -50, y: 100, zoom: 1.5 },
} as const;

describe('POST /agents', () => {
  let baseDir: string;
  let agentStore: AgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d06b-create-'));
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
  const create = (body: object) => request(app()).post('/agents').send(body);
  const listVersions = async (id: string): Promise<VersionListItem[]> =>
    (await request(app()).get(`/agents/${id}/versions`)).body as VersionListItem[];

  describe('blank create', () => {
    it('creates untitled-agent then untitled-agent-2, each with a kind:create version 1', async () => {
      const first = await create({ from: 'blank' });
      expect(first.status).toBe(201);
      const firstRecord = first.body as AgentRecord;
      expect(firstRecord.id).toBe('untitled-agent');
      expect(firstRecord.spec).toMatchObject({
        version: 2,
        name: 'Untitled agent',
        model: 'mock/mock-1',
        instructions: 'You are a helpful agent.',
      });
      expect(firstRecord.meta).toMatchObject({ enabled: true, createdFrom: { kind: 'blank' } });
      expect(firstRecord.latestVersion).toBe(1);

      const second = await create({ from: 'blank' });
      expect(second.status).toBe(201);
      expect((second.body as AgentRecord).id).toBe('untitled-agent-2');

      const versions = await listVersions('untitled-agent');
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ version: 1, kind: 'create', source: 'editor' });
    });

    it('slugs the id off name and keeps name as the display text', async () => {
      const res = await create({ from: 'blank', name: 'My Agent' });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe('my-agent');
      expect(res.body.spec.name).toBe('My Agent');
    });
  });

  describe('copy create', () => {
    const seedSource = async (id = 'a') => {
      await request(app()).put(`/agents/${id}`).send({ spec: { ...V2_SPEC, name: 'a' } }).expect(204);
      await request(app()).patch(`/agents/${id}/meta`).send({ labels: ['Ops', 'billing'] }).expect(200);
      await request(app()).put(`/agents/${id}/layout`).send(LAYOUT).expect(204);
    };

    it('copies spec (name + " copy"), labels and layout into a-copy then a-copy-2, source unchanged', async () => {
      await seedSource('a');

      const first = await create({ from: { copyOf: 'a' } });
      expect(first.status).toBe(201);
      const copy = first.body as AgentRecord;
      expect(copy.id).toBe('a-copy');
      expect(copy.spec.name).toBe('a copy');
      expect(copy.spec.description).toBe('Watches the queues.');
      expect(copy.meta.labels).toEqual(['ops', 'billing']);
      expect(copy.meta).toMatchObject({
        enabled: true,
        createdFrom: { kind: 'copy', ref: 'a' },
        publishedVersion: null,
      });
      expect(copy.layout).toEqual(LAYOUT);
      expect(copy.latestVersion).toBe(1);

      const second = await create({ from: { copyOf: 'a' } });
      expect(second.status).toBe(201);
      expect(second.body.id).toBe('a-copy-2');

      const source = (await request(app()).get('/agents/a')).body as AgentRecord;
      expect(source.spec.name).toBe('a');
      expect(source.meta.labels).toEqual(['ops', 'billing']);
      expect(source.layout).toEqual(LAYOUT);
      expect(source.latestVersion).toBeNull();
    });

    it('lets name override the "<name> copy" default while the id stays <id>-copy', async () => {
      await seedSource('a');
      const res = await create({ from: { copyOf: 'a' }, name: 'Renamed' });
      expect(res.status).toBe(201);
      expect(res.body.spec.name).toBe('Renamed');
      expect(res.body.id).toBe('a-copy');
    });

    it('404s LOUSHO_AGENT_NOT_FOUND for a missing copyOf', async () => {
      const res = await create({ from: { copyOf: 'ghost' } });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "No saved agent 'ghost'", code: 'LOUSHO_AGENT_NOT_FOUND' });
    });
  });

  it('does not reuse an id whose <id>/ sidecar dir exists (deleted agent with history)', async () => {
    const created = await create({ from: 'blank', name: 'gone' });
    expect(created.status).toBe(201);
    await request(app()).delete('/agents/gone').expect(204);
    expect(fs.existsSync(repo.sidecarDir('gone'))).toBe(true);

    const again = await create({ from: 'blank', name: 'gone' });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe('gone-2');
  });

  it('400s LOUSHO_TEMPLATE_UNAVAILABLE for { template }', async () => {
    const res = await create({ from: { template: 'x' } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Creating from a template is not available yet.',
      code: 'LOUSHO_TEMPLATE_UNAVAILABLE',
    });
  });

  it("400s LOUSHO_SPEC_INVALID when name fails the spec name rule ('bad/name!')", async () => {
    const res = await create({ from: 'blank', name: 'bad/name!' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOUSHO_SPEC_INVALID');
    expect(repo.listIds()).toEqual([]);
  });

  it.each([[{}], [{ from: 'x' }], [{ from: { copyOf: 5 } }], [{ from: {} }], [{ from: 'blank', name: 7 }]])(
    '400s LOUSHO_BODY_INVALID for %j',
    async (body) => {
      const res = await create(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LOUSHO_BODY_INVALID');
    }
  );
});

describe('PUT /agents/:id/layout', () => {
  let baseDir: string;
  let agentStore: AgentStore;
  let runManager: RunManager;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d06b-layout-'));
    agentStore = createFsAgentStore(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
    });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const app = () => createApp({ agentStore, runManager, baseDir });
  const createBlank = async (name = 'ops') => {
    const res = await request(app()).post('/agents').send({ from: 'blank', name });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  it('round-trips through GET /agents/:id as record.layout', async () => {
    const id = await createBlank();
    const res = await request(app()).put(`/agents/${id}/layout`).send(LAYOUT);
    expect(res.status).toBe(204);
    const record = (await request(app()).get(`/agents/${id}`)).body as AgentRecord;
    expect(record.layout).toEqual(LAYOUT);
  });

  it('400s LOUSHO_LAYOUT_INVALID naming viewport.zoom for zoom: 9', async () => {
    const id = await createBlank();
    const res = await request(app())
      .put(`/agents/${id}/layout`)
      .send({ ...LAYOUT, viewport: { x: 0, y: 0, zoom: 9 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOUSHO_LAYOUT_INVALID');
    expect(res.body.error).toContain('viewport.zoom');
  });

  it('404s LOUSHO_AGENT_NOT_FOUND for an unknown agent', async () => {
    const res = await request(app()).put('/agents/ghost/layout').send(LAYOUT);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('LOUSHO_AGENT_NOT_FOUND');
  });
});
