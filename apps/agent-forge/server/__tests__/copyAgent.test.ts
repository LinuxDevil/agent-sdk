/**
 * `POST /agents { from: { copyOf } }` through lifecycle/copy.ts (L10):
 * `<id>-copy` naming, spec/labels/layout copying with fresh note ids,
 * the turned-off meta rules, one `create` version, no copied history
 * folders and the 404 for an unknown source.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpecV2 } from 'lousho';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { TemplateCatalog } from '../templates/templateCatalog';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import type { AgentRecord, VersionListItem } from '../../shared/wireTypes';

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'Support triage',
  description: 'Watches the queues.',
  model: 'mock/mock-1',
  instructions: 'Check the queues.',
};

const LAYOUT = {
  schemaVersion: 1,
  nodes: { agent: { x: 10, y: 20 } },
  notes: [
    { id: 'n1', x: 0, y: 0, text: 'first' },
    { id: 'n2', x: 40, y: 0, text: 'second' },
  ],
  viewport: { x: -50, y: 100, zoom: 1.5 },
} as const;

describe('copyAgent', () => {
  let baseDir: string;
  let templatesDir: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l10-copy-'));
    templatesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l10-tpl-'));
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
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(templatesDir, { recursive: true, force: true });
  });

  const app = () =>
    createApp({ agentStore, runManager, baseDir, templateCatalog: new TemplateCatalog(templatesDir) });
  const create = (body: object) => request(app()).post('/agents').send(body);
  const listVersions = async (id: string): Promise<VersionListItem[]> =>
    (await request(app()).get(`/agents/${id}/versions`)).body as VersionListItem[];

  /** A saved, labelled, laid-out source agent with history folders that must not copy. */
  async function seedSource(id = 'support-triage', name = 'Support triage') {
    await request(app())
      .put(`/agents/${id}`)
      .send({ spec: { ...SPEC, name } })
      .expect(204);
    await request(app()).patch(`/agents/${id}/meta`).send({ labels: ['Ops', 'billing'] }).expect(200);
    await request(app()).put(`/agents/${id}/layout`).send(LAYOUT).expect(204);
    // History the copy must not inherit: two versions plus the
    // drafts/suggestions/traces/chats/approvals/checkpoints sidecar dirs.
    await request(app()).post(`/agents/${id}/versions`).send({}).expect(201);
    await request(app())
      .put(`/agents/${id}`)
      .send({ spec: { ...SPEC, name, instructions: 'Check the queues twice.' } })
      .expect(204);
    await request(app()).post(`/agents/${id}/versions`).send({}).expect(201);
    for (const dir of ['drafts', 'suggestions', 'traces', 'chats', 'approvals', 'checkpoints']) {
      fs.mkdirSync(path.join(repo.sidecarDir(id), dir), { recursive: true });
      fs.writeFileSync(path.join(repo.sidecarDir(id), dir, 'x.json'), '{}');
    }
  }

  it('names copies <id>-copy then <id>-copy-2', async () => {
    await seedSource();
    const first = await create({ from: { copyOf: 'support-triage' } });
    expect(first.status).toBe(201);
    expect((first.body as AgentRecord).id).toBe('support-triage-copy');
    const second = await create({ from: { copyOf: 'support-triage' } });
    expect(second.status).toBe(201);
    expect((second.body as AgentRecord).id).toBe('support-triage-copy-2');
  });

  it('copies the spec except name, plus labels and layout positions; notes get fresh ids', async () => {
    await seedSource();
    const res = await create({ from: { copyOf: 'support-triage' } });
    expect(res.status).toBe(201);
    const copy = res.body as AgentRecord;
    const source = (await request(app()).get('/agents/support-triage')).body as AgentRecord;

    expect(copy.spec).toEqual({ ...source.spec, name: 'Support triage copy' });
    expect(copy.meta.labels).toEqual(['ops', 'billing']);
    expect(copy.layout.nodes).toEqual(LAYOUT.nodes);
    expect(copy.layout.viewport).toEqual(LAYOUT.viewport);
    expect(copy.layout.notes.map((n) => [n.x, n.y, n.text])).toEqual([
      [0, 0, 'first'],
      [40, 0, 'second'],
    ]);
    const noteIds = copy.layout.notes.map((n) => n.id);
    expect(noteIds).toHaveLength(2);
    expect(new Set(noteIds).size).toBe(2);
    expect(noteIds).not.toContain('n1');
    expect(noteIds).not.toContain('n2');
  });

  it('turns the copy off with copy provenance even when the source is enabled', async () => {
    await seedSource();
    const source = (await request(app()).get('/agents/support-triage')).body as AgentRecord;
    expect(source.meta.enabled).toBe(true);

    const res = await create({ from: { copyOf: 'support-triage' } });
    const copy = res.body as AgentRecord;
    expect(copy.meta).toMatchObject({
      enabled: false,
      publishedVersion: null,
      failureStreak: 0,
      createdFrom: { kind: 'copy', ref: 'support-triage' },
    });
  });

  it('gives the copy exactly one create version and none of the source history folders', async () => {
    await seedSource();
    const res = await create({ from: { copyOf: 'support-triage' } });
    const copy = res.body as AgentRecord;
    expect(copy.latestVersion).toBe(1);

    const versions = await listVersions('support-triage-copy');
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, kind: 'create', source: 'copy' });

    const sidecar = repo.sidecarDir('support-triage-copy');
    for (const dir of ['drafts', 'suggestions', 'traces', 'chats', 'approvals', 'checkpoints']) {
      expect(fs.existsSync(path.join(sidecar, dir))).toBe(false);
    }
    // The source's history stayed behind: the copy has only its own v1
    // (the versions dir also holds the index.jsonl ledger).
    const versionFiles = fs
      .readdirSync(path.join(sidecar, 'versions'))
      .filter((file) => file.endsWith('.json') && file !== 'index.json');
    expect(versionFiles).toEqual(['000001.json']);
    // And the source itself is untouched.
    const sourceVersions = await listVersions('support-triage');
    expect(sourceVersions).toHaveLength(2);
  });

  it('honours a name override and keeps "<name> copy" within 64 chars', async () => {
    await seedSource('long-name', 'x'.repeat(64));
    const renamed = await create({ from: { copyOf: 'long-name' }, name: 'Renamed' });
    expect(renamed.status).toBe(201);
    expect((renamed.body as AgentRecord).spec.name).toBe('Renamed');

    const res = await create({ from: { copyOf: 'long-name' } });
    expect(res.status).toBe(201);
    const name = (res.body as AgentRecord).spec.name;
    expect(name).toBe(`${'x'.repeat(59)} copy`);
    expect(name).toHaveLength(64);
  });

  it('404s LOUSHO_AGENT_NOT_FOUND for an unknown copyOf', async () => {
    const res = await create({ from: { copyOf: 'ghost' } });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No agent 'ghost' to copy", code: 'LOUSHO_AGENT_NOT_FOUND' });
  });
});
