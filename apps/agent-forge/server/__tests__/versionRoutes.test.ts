import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { stringify as stringifyYaml } from 'yaml';
import type { AgentSpec } from 'lousho';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import type { AgentStore } from '../../src/persistence/AgentStore';
import { AgentRepo } from '../storage/agentRepo';
import type { SpecChange, VersionListItem, VersionRecord } from '../../shared/wireTypes';

const V1_SPEC: AgentSpec = {
  name: 'ops',
  prompt: 'Check the queues.',
  provider: { type: 'mock', model: 'mock-1' },
};

const V1_SPEC_EDITED: AgentSpec = {
  ...V1_SPEC,
  prompt: 'Check the queues faster.',
};

/**
 * The version routes: `GET/POST /agents/:id/versions`,
 * `GET /agents/:id/versions/:n`, `GET .../versions/:n/diff?against=:m` and
 * `POST .../versions/:n/restore` over the workspace seam's `versions` store.
 */
describe('version routes', () => {
  let baseDir: string;
  let agentStore: AgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d07-versions-'));
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

  /** Saves the agent through the real v1 PUT route (the file on disk is v2). */
  const saveAgent = async (id = 'ops', spec: AgentSpec = V1_SPEC) => {
    const res = await request(app()).put(`/agents/${id}`).send(spec);
    expect(res.status).toBe(204);
  };

  const saveVersion = (id = 'ops', body: object = {}) => request(app()).post(`/agents/${id}/versions`).send(body);
  const listVersions = (id = 'ops') => request(app()).get(`/agents/${id}/versions`);
  const indexLines = (id: string): { kind: string; source: string }[] => {
    const file = path.join(repo.sidecarDir(id), 'versions', 'index.jsonl');
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line))
      : [];
  };

  it('GET lists [] for a saved agent without versions and 404 LOUSHO_AGENT_NOT_FOUND for an unknown one', async () => {
    await saveAgent();
    const empty = await listVersions();
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    const missing = await listVersions('ghost');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('LOUSHO_AGENT_NOT_FOUND');
  });

  it('explicit saves capture create/update versions; GET lists them newest first', async () => {
    await saveAgent();
    const first = await saveVersion('ops', { source: 'editor' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ version: 1, kind: 'create', source: 'editor' });

    await saveAgent('ops', V1_SPEC_EDITED);
    const second = await saveVersion();
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ version: 2, kind: 'update', source: 'editor' });
    expect(second.body.changedFields).toContain('instructions');

    const list = await listVersions();
    expect(list.body.map((item: VersionListItem) => item.version)).toEqual([2, 1]);
  });

  it('explicit save with no change since the latest version is a 200 no-op - nothing appended', async () => {
    await saveAgent();
    await saveVersion();

    const again = await saveVersion();
    expect(again.status).toBe(200);
    expect(again.body.version).toBe(1);
    expect(indexLines('ops')).toHaveLength(1);
  });

  it('POST rejects a source other than editor and unknown agents', async () => {
    await saveAgent();
    const bad = await saveVersion('ops', { source: 'author' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('LOUSHO_BODY_INVALID');

    const missing = await saveVersion('ghost');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('LOUSHO_AGENT_NOT_FOUND');
  });

  it('GET /versions/:n returns the record, 404 when absent and 400 for a bad number', async () => {
    await saveAgent();
    await saveVersion();

    const got = await request(app()).get('/agents/ops/versions/1');
    expect(got.status).toBe(200);
    const record = got.body as VersionRecord;
    expect(record.version).toBe(1);
    expect(record.snapshot.spec.name).toBe('ops');
    expect(record.snapshot.labels).toEqual([]);

    const missing = await request(app()).get('/agents/ops/versions/9');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "No version 9 of 'ops'", code: 'LOUSHO_VERSION_NOT_FOUND' });

    for (const n of ['abc', '0', '-1', '1.5']) {
      const res = await request(app()).get(`/agents/ops/versions/${n}`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Version must be a positive whole number', code: 'LOUSHO_VERSION_INVALID' });
    }
  });

  it('diff of v2 against the default (v1) lists the change; v1 diffs as all adds; against=abc is 400', async () => {
    await saveAgent();
    await saveVersion();
    await saveAgent('ops', V1_SPEC_EDITED);
    await saveVersion();

    const def = await request(app()).get('/agents/ops/versions/2/diff');
    expect(def.status).toBe(200);
    const changes = def.body as SpecChange[];
    expect(changes).toEqual([
      {
        field: 'instructions',
        label: 'Instructions',
        section: 'Instructions',
        op: 'edit',
        before: 'Check the queues.',
        after: 'Check the queues faster.',
        lines: [
          { kind: 'del', text: 'Check the queues.' },
          { kind: 'add', text: 'Check the queues faster.' },
        ],
      },
    ]);

    const explicit = await request(app()).get('/agents/ops/versions/2/diff?against=1');
    expect(explicit.status).toBe(200);
    expect(explicit.body).toEqual(changes);

    const initial = await request(app()).get('/agents/ops/versions/1/diff');
    expect(initial.status).toBe(200);
    expect((initial.body as SpecChange[]).length).toBeGreaterThan(0);
    expect((initial.body as SpecChange[]).every((c) => c.op === 'add')).toBe(true);

    const badAgainst = await request(app()).get('/agents/ops/versions/2/diff?against=abc');
    expect(badAgainst.status).toBe(400);
    expect(badAgainst.body.code).toBe('LOUSHO_VERSION_INVALID');

    expect((await request(app()).get('/agents/ops/versions/9/diff')).body.code).toBe('LOUSHO_VERSION_NOT_FOUND');
    expect((await request(app()).get('/agents/ops/versions/2/diff?against=9')).body.code).toBe(
      'LOUSHO_VERSION_NOT_FOUND'
    );
  });

  it('restore writes a kind:restore version: the working copy and labels go back to v1, enabled stays false', async () => {
    await saveAgent();
    const meta = await repo.readMeta('ops');
    await repo.writeMeta('ops', { ...meta, labels: ['v1labels'] });
    await saveVersion();
    await saveAgent('ops', V1_SPEC_EDITED);
    await repo.writeMeta('ops', { ...meta, labels: ['v2labels'] });
    await saveVersion();

    // The restore must not re-enable a disabled agent.
    await repo.writeMeta('ops', { ...(await repo.readMeta('ops')), enabled: false });

    const res = await request(app()).post('/agents/ops/versions/1/restore');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      version: 3,
      kind: 'restore',
      source: 'restore',
      restoredFromVersion: 1,
    });

    const spec = await repo.readSpec('ops');
    const v1 = (await request(app()).get('/agents/ops/versions/1')).body as VersionRecord;
    expect(spec?.instructions).toBe('Check the queues.');
    expect(spec?.name).toBe(v1.snapshot.spec.name);

    const afterMeta = await repo.readMeta('ops');
    expect(afterMeta.labels).toEqual(['v1labels']);
    expect(afterMeta.enabled).toBe(false);
  });

  it('restore of a missing version is 404 LOUSHO_VERSION_NOT_FOUND and a bad number is 400', async () => {
    await saveAgent();
    const missing = await request(app()).post('/agents/ops/versions/4/restore');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('LOUSHO_VERSION_NOT_FOUND');
    const bad = await request(app()).post('/agents/ops/versions/abc/restore');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('LOUSHO_VERSION_INVALID');
  });

  it("restore of a snapshot today's schema rejects is 400 LOUSHO_RESTORE_INVALID, working copy untouched", async () => {
    await saveAgent();
    await saveVersion();

    // Hand-write a record file whose snapshot no longer validates (as if the
    // schema had moved on since it was captured).
    const record = {
      version: 7,
      kind: 'update',
      source: 'editor',
      changedFields: [],
      restoredFromVersion: null,
      summary: null,
      requestText: null,
      authorSessionId: null,
      specHash: 'sha256:bad',
      createdAt: new Date().toISOString(),
      snapshot: {
        spec: { version: 2, name: '', model: 'mock/mock-1', instructions: 'Run.' },
        labels: ['stale'],
      },
    };
    const versionsDir = path.join(repo.sidecarDir('ops'), 'versions');
    fs.writeFileSync(path.join(versionsDir, '000007.json'), JSON.stringify(record));

    const res = await request(app()).post('/agents/ops/versions/7/restore');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOUSHO_RESTORE_INVALID');
    expect(res.body.error).toContain('no longer passes validation');
    expect(Array.isArray(res.body.details?.issues)).toBe(true);

    const spec = await repo.readSpec('ops');
    expect(spec?.instructions).toBe('Check the queues.');
    expect((await repo.readMeta('ops')).labels).toEqual([]);
    expect(indexLines('ops')).toHaveLength(1);
  });

  it('save after a hand edit baselines the on-disk change first; the save itself is a 200 no-op', async () => {
    await saveAgent();
    // Hand-edit the yaml outside Studio: hash matches neither the (empty)
    // index nor the working.json marker -> reconcileExternalEdit baselines it.
    fs.writeFileSync(
      repo.specPath('ops'),
      stringifyYaml({ version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Hand edited.' })
    );

    const res = await saveVersion();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 1, kind: 'baseline', source: 'external_file_edit' });
    expect(indexLines('ops')).toHaveLength(1);

    // And a second explicit save stays a no-op against that baseline.
    const again = await saveVersion();
    expect(again.status).toBe(200);
    expect(again.body.version).toBe(1);
    expect(indexLines('ops')).toHaveLength(1);
  });
});
