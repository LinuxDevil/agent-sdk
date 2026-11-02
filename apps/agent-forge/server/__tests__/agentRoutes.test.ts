/**
 * Agent routes v2 - `GET /agents` (AgentListItem[]), `GET /agents/:id`
 * (AgentRecord), `PUT /agents/:id` (`{ spec }` v2 or a bare v1 spec) and
 * `DELETE /agents/:id`, with the temporary `?view=legacy` v1 bridge the
 * canvas still reads (routes/agentRoutes.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { parse as parseYaml } from 'yaml';
import type { AgentSpec, AgentSpecV2 } from 'lousho';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import type { AgentStore } from '../../src/persistence/AgentStore';
import type { AgentListItem, AgentRecord } from '../../shared/wireTypes';

const V1_SPEC: AgentSpec = {
  name: 'ops',
  prompt: 'Check the queues.',
  provider: { type: 'mock', model: 'mock-1' },
};

const V2_SPEC: AgentSpecV2 = {
  version: 2,
  name: 'ops',
  description: 'Watches the queues.',
  model: 'mock/mock-1',
  instructions: 'Check the queues.',
};

describe('agent routes v2', () => {
  let baseDir: string;
  let agentStore: AgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d06a-agents-'));
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
    vi.restoreAllMocks();
  });

  const app = () => createApp({ agentStore, runManager, baseDir });

  const putV2 = (id: string, spec: unknown = V2_SPEC) =>
    request(app()).put(`/agents/${id}`).send({ spec });

  const specDoc = (id: string): Record<string, unknown> =>
    parseYaml(fs.readFileSync(repo.specPath(id), 'utf8')) as Record<string, unknown>;

  describe('GET /agents', () => {
    it('answers [] when no agents are saved', async () => {
      const res = await request(app()).get('/agents');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('lists items sorted by id, with meta defaults and counts', async () => {
      await putV2('zed', { ...V2_SPEC, name: 'zed' });
      await putV2('ann', { ...V2_SPEC, name: 'ann', description: undefined });
      const res = await request(app()).get('/agents');
      expect(res.status).toBe(200);
      const items = res.body as AgentListItem[];
      expect(items.map((item) => item.id)).toEqual(['ann', 'zed']);
      const [ann] = items;
      expect(ann).toMatchObject({
        id: 'ann',
        name: 'ann',
        description: '',
        model: 'mock/mock-1',
        enabled: true,
        labels: [],
        publishedVersion: null,
        counts: { tools: 0, mcpServers: 0, subagents: 0, triggers: 0 },
      });
      expect(typeof ann.updatedAt).toBe('string');
      expect(ann).not.toHaveProperty('lastRun');
    });

    it('skips a spec file it cannot read instead of failing the list', async () => {
      await putV2('good');
      fs.mkdirSync(repo.agentsDir(), { recursive: true });
      fs.writeFileSync(path.join(repo.agentsDir(), 'broken.yaml'), 'name: [unclosed\n');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await request(app()).get('/agents');
      expect(res.status).toBe(200);
      expect((res.body as AgentListItem[]).map((item) => item.id)).toEqual(['good']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'broken'"));
    });

    it('counts tools, mcp servers, subagents and triggers from the spec', async () => {
      await putV2('rich', {
        ...V2_SPEC,
        name: 'rich',
        tools: [{ builtin: 'current_date' }, { builtin: 'day_name' }],
        mcpServers: { github: { command: 'npx', args: ['-y', 'github-mcp'] } },
      });
      const res = await request(app()).get('/agents');
      expect(res.status).toBe(200);
      expect((res.body as AgentListItem[])[0].counts).toEqual({
        tools: 2,
        mcpServers: 1,
        subagents: 0,
        triggers: 0,
      });
    });

    it('?view=legacy keeps the AgentStoreEntry list shape', async () => {
      await putV2('ops');
      const res = await request(app()).get('/agents?view=legacy');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      const entry = res.body[0];
      expect(entry.id).toBe('ops');
      expect(entry.spec).toMatchObject({
        name: 'ops',
        prompt: 'Check the queues.',
        provider: { type: 'mock', model: 'mock-1' },
      });
      expect(entry.spec.version).toBeUndefined();
      expect(typeof entry.updatedAt).toBe('string');
    });
  });

  describe('lastRun', () => {
    it('reports the live run status when it is not idle', async () => {
      await putV2('ops');
      runManager.status = vi.fn().mockReturnValue({
        agentId: 'ops',
        status: 'running',
        traceId: 'trace-1',
        updatedAt: '2026-01-02T03:04:05.000Z',
      }) as unknown as RunManager['status'];
      const res = await request(app()).get('/agents');
      expect(res.status).toBe(200);
      expect((res.body as AgentListItem[])[0].lastRun).toEqual({
        status: 'running',
        at: '2026-01-02T03:04:05.000Z',
        traceId: 'trace-1',
      });
    });

    it('falls back to the newest persisted trace', async () => {
      await putV2('ops');
      const dir = path.join(baseDir, '.lousho', 'agents', 'ops', 'traces', '2026-10-02');
      fs.mkdirSync(dir, { recursive: true });
      const root = {
        v: 1,
        traceId: 't1',
        id: 't1',
        name: 'invoke_agent ops',
        kind: 'internal',
        startTime: 1000,
        endTime: 1500,
        attributes: {},
        status: { code: 'ok' },
      };
      fs.writeFileSync(path.join(dir, 't1.jsonl'), `${JSON.stringify(root)}\n`);
      const res = await request(app()).get('/agents');
      expect(res.status).toBe(200);
      expect((res.body as AgentListItem[])[0].lastRun).toEqual({
        status: 'done',
        at: new Date(1500).toISOString(),
        traceId: 't1',
      });
    });

    it('maps an errored trace to lastRun.status error', async () => {
      await putV2('ops');
      const dir = path.join(baseDir, '.lousho', 'agents', 'ops', 'traces', '2026-10-02');
      fs.mkdirSync(dir, { recursive: true });
      const root = {
        v: 1,
        traceId: 'r1',
        id: 'r1',
        name: 'invoke_agent ops',
        kind: 'internal',
        startTime: 1000,
        endTime: 1250,
        attributes: {},
        status: { code: 'error', message: 'boom' },
      };
      fs.writeFileSync(path.join(dir, 'r1.jsonl'), `${JSON.stringify(root)}\n`);
      const res = await request(app()).get('/agents');
      expect((res.body as AgentListItem[])[0].lastRun).toMatchObject({ status: 'error', traceId: 'r1' });
    });
  });

  describe('GET /agents/:id', () => {
    it('404s with LOUSHO_AGENT_NOT_FOUND for an unknown id', async () => {
      const res = await request(app()).get('/agents/nope');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "No saved agent 'nope'", code: 'LOUSHO_AGENT_NOT_FOUND' });
    });

    it('returns the record: spec v2, meta, layout and latestVersion null without versions', async () => {
      await putV2('ops');
      const res = await request(app()).get('/agents/ops');
      expect(res.status).toBe(200);
      const record = res.body as AgentRecord;
      expect(record.id).toBe('ops');
      expect(record.spec).toMatchObject({ version: 2, name: 'ops', model: 'mock/mock-1' });
      expect(record.meta).toMatchObject({ schemaVersion: 1, enabled: true, labels: [], publishedVersion: null });
      expect(record.layout).toEqual({ schemaVersion: 1, nodes: {}, notes: [] });
      expect(record.latestVersion).toBeNull();
      expect(typeof record.updatedAt).toBe('string');
    });

    it('reports latestVersion after a capture', async () => {
      await putV2('ops');
      await request(app()).post('/agents/ops/versions').send({}).expect(201);
      const res = await request(app()).get('/agents/ops');
      expect((res.body as AgentRecord).latestVersion).toBe(1);
    });

    it('?view=legacy returns the v1 spec and 404s the same way', async () => {
      await putV2('ops');
      const res = await request(app()).get('/agents/ops?view=legacy');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        name: 'ops',
        prompt: 'Check the queues.',
        provider: { type: 'mock', model: 'mock-1' },
      });
      expect(res.body.version).toBeUndefined();

      const missing = await request(app()).get('/agents/nope?view=legacy');
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: "No saved agent 'nope'", code: 'LOUSHO_AGENT_NOT_FOUND' });
    });
  });

  describe('PUT /agents/:id', () => {
    it('accepts { spec } and writes a spec v2 working copy', async () => {
      const res = await putV2('ops');
      expect(res.status).toBe(204);
      expect(specDoc('ops')).toMatchObject({ version: 2, name: 'ops', model: 'mock/mock-1' });
    });

    it('rejects an invalid spec with LOUSHO_SPEC_INVALID and issue details', async () => {
      const res = await putV2('ops', { version: 2, name: 'ops' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LOUSHO_SPEC_INVALID');
      expect(typeof res.body.details.issues[0].path).toBe('string');
      expect(res.body.details.issues[0].path.length).toBeGreaterThan(0);
    });

    it('still accepts a bare v1 spec (the canvas autosave) and preserves v2-only keys', async () => {
      await putV2('ops', { ...V2_SPEC, description: 'kept across saves' });
      const res = await request(app()).put('/agents/ops').send(V1_SPEC);
      expect(res.status).toBe(204);
      expect(specDoc('ops')).toMatchObject({ version: 2, description: 'kept across saves' });
    });

    it('creates a v1 save when there is no stored spec', async () => {
      const res = await request(app()).put('/agents/fresh').send(V1_SPEC);
      expect(res.status).toBe(204);
      expect(specDoc('fresh')).toMatchObject({
        version: 2,
        name: 'ops',
        model: 'mock/mock-1',
        instructions: 'Check the queues.',
      });
    });

    it.each([[[2]], ['x'], [{}]])('rejects a garbage body %j with LOUSHO_BODY_INVALID', async (body) => {
      const res = await request(app()).put('/agents/ops').send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LOUSHO_BODY_INVALID');
    });

    it('does not accept a bare v2 spec without the { spec } wrapper', async () => {
      const res = await request(app()).put('/agents/ops').send(V2_SPEC);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LOUSHO_BODY_INVALID');
    });

    it('writes a baseline version first when the yaml was edited outside Studio', async () => {
      await putV2('ops');
      // A hand edit: same shape, different content - the file's hash now
      // matches neither working.json nor any version.
      fs.writeFileSync(repo.specPath('ops'), 'version: 2\nname: ops\nmodel: mock/mock-2\ninstructions: Hand edited.\n');
      const res = await putV2('ops');
      expect(res.status).toBe(204);
      const index = fs.readFileSync(path.join(repo.sidecarDir('ops'), 'versions', 'index.jsonl'), 'utf8');
      const lines = index
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line));
      expect(lines).toContainEqual(expect.objectContaining({ kind: 'baseline', source: 'external_file_edit' }));
    });
  });

  describe('DELETE /agents/:id', () => {
    it('removes the spec and its sidecars, 204', async () => {
      await putV2('ops');
      const res = await request(app()).delete('/agents/ops');
      expect(res.status).toBe(204);
      expect(fs.existsSync(repo.specPath('ops'))).toBe(false);
      await request(app()).get('/agents/ops').expect(404);
    });
  });
});
