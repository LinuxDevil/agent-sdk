/**
 * L08a import routes - `POST /agents/import/preview` and
 * `POST /agents/import` (lifecycle/import.ts): preview fields, the
 * new/copy/replace writes, bundle prompt registration and the
 * `agent.changed` publish. Registered before the `/agents/:id` routes,
 * so `import` is never read as an agent id.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { VersionStore } from '../storage/versionStore';
import { StudioEventBus } from '../events/eventBus';
import { SecretsStore } from '../secretsStore';
import { studioPathsFor } from '../workspace/studioPaths';
import { workspaceRefFor } from '../workspace/workspaceId';
import { runImport } from '../lifecycle/import';
import type { WorkspaceContext } from '../workspace/context';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import type { AgentMeta, ImportPreview, StudioEvent, VersionListItem } from '../../shared/wireTypes';

const V1_YAML = ['name: Support triage', 'prompt: Help the users.', 'provider:', '  type: anthropic', '  model: claude-sonnet-5-5', ''].join('\n');

const V2_SPEC: AgentSpecV2 = {
  version: 2,
  name: 'Ops Bot',
  model: 'mock/mock-1',
  instructions: 'Do the ops.',
};
const V2_JSON = JSON.stringify(V2_SPEC);

const BUNDLE = JSON.stringify({
  kind: 'lousho.agent-bundle',
  version: 1,
  spec: { version: 2, name: 'Bundle Bot', model: 'mock/mock-1', instructions: 'From a bundle.' },
  labels: [' Prod ', 'OPS'],
  prompts: [{ name: 'support', version: 3, content: 'Be nice.' }],
  exportedAt: '2026-01-01T00:00:00.000Z',
});

/** A fetch stub that records calls and answers 200. */
function recordingFetch() {
  return vi.fn<[RequestInfo | URL, (RequestInit | undefined)?], Promise<Response>>(
    async () => new Response('{}', { status: 200 })
  );
}

describe('POST /agents/import[/preview]', () => {
  let baseDir: string;
  let studioHome: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l08a-import-'));
    studioHome = path.join(baseDir, '.lousho');
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const app = () =>
    createApp({
      agentStore,
      runManager,
      baseDir,
      studioHome,
      secretsStore: new SecretsStore(studioPathsFor(studioHome)),
    });
  const preview = (body: object) => request(app()).post('/agents/import/preview').send(body);
  const doImport = (body: object) => request(app()).post('/agents/import').send(body);
  const versions = async (id: string) =>
    (await request(app()).get(`/agents/${id}/versions`)).body as VersionListItem[];

  it('previews a JSON spec: format, suggested/resolved id, requirements, no clash', async () => {
    const res = await preview({ text: V2_JSON, mode: 'new' });
    expect(res.status).toBe(200);
    const p = res.body as ImportPreview;
    expect(p.format).toBe('json');
    expect(p.spec).toMatchObject({ version: 2, name: 'Ops Bot' });
    expect(p.suggestedId).toBe('ops-bot');
    expect(p.clash).toBeNull();
    expect(p.resolvedId).toBe('ops-bot');
    expect(Array.isArray(p.requirements)).toBe(true);
    expect(p.prompts).toEqual([]);
    expect(p.warnings).toEqual([]);
  });

  it('previews a v1 YAML spec with the upgrade warning', async () => {
    const res = await preview({ text: V1_YAML, mode: 'new' });
    expect(res.status).toBe(200);
    const p = res.body as ImportPreview;
    expect(p.format).toBe('yaml');
    expect(p.spec.version).toBe(2);
    expect(p.warnings).toContain('Upgraded from spec v1.');
  });

  it('previews a bundle with labels, prompts and the daemon warning', async () => {
    const res = await preview({ text: BUNDLE, mode: 'new' });
    expect(res.status).toBe(200);
    const p = res.body as ImportPreview;
    expect(p.format).toBe('bundle');
    expect(p.labels).toEqual(['prod', 'ops']);
    expect(p.prompts).toEqual([{ name: 'support', version: 3 }]);
    expect(p.warnings).toContain("Prompt 'support' will be added to the observe daemon if it is running.");
  });

  it('reports the clash and per-mode resolved ids', async () => {
    const created = await request(app()).post('/agents').send({ from: 'blank', name: 'Support triage' });
    expect(created.status).toBe(201);
    expect(created.body.id).toBe('support-triage');

    const asNew = await preview({ text: V1_YAML, mode: 'new' });
    expect(asNew.body.clash).toEqual({ id: 'support-triage', name: 'Support triage' });
    expect(asNew.body.resolvedId).toBe('support-triage-2');

    const asCopy = await preview({ text: V1_YAML, mode: 'copy' });
    expect(asCopy.body.resolvedId).toBe('support-triage-copy');
  });

  it('mode=new writes a disabled agent with createdFrom import and a create/import version', async () => {
    const res = await doImport({ text: V2_JSON, mode: 'new' });
    expect(res.status).toBe(201);
    const record = res.body as { id: string; meta: AgentMeta; spec: AgentSpecV2 };
    expect(record.id).toBe('ops-bot');
    expect(record.spec.name).toBe('Ops Bot');
    expect(record.meta.enabled).toBe(false);
    expect(record.meta.createdFrom).toEqual({ kind: 'import' });
    expect(fs.existsSync(repo.specPath('ops-bot'))).toBe(true);

    const list = await versions('ops-bot');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'create', source: 'import' });
  });

  it('mode=copy writes <base>-copy with createdFrom copy ref', async () => {
    const res = await doImport({ text: V2_JSON, mode: 'copy' });
    expect(res.status).toBe(201);
    const record = res.body as { id: string; meta: AgentMeta };
    expect(record.id).toBe('ops-bot-copy');
    expect(record.meta.createdFrom).toEqual({ kind: 'copy', ref: 'ops-bot' });
    expect(record.meta.enabled).toBe(false);
  });

  it('mode=new on a bundle stores the normalised labels', async () => {
    const res = await doImport({ text: BUNDLE, mode: 'new' });
    expect(res.status).toBe(201);
    const record = res.body as { id: string; meta: AgentMeta };
    expect(record.id).toBe('bundle-bot');
    expect(record.meta.labels).toEqual(['prod', 'ops']);
  });

  it('mode=replace keeps enabled/publishedVersion, updates labels only for bundles, captures update/import', async () => {
    const created = await request(app()).post('/agents').send({ from: 'blank', name: 'Ops Bot' });
    expect(created.status).toBe(201);
    expect(created.body.id).toBe('ops-bot');
    // publishedVersion + disabled state the import must preserve.
    const meta = await repo.readMeta('ops-bot');
    await repo.writeMeta('ops-bot', { ...meta, publishedVersion: 1 });

    const res = await doImport({ text: V2_JSON, mode: 'replace', targetId: 'ops-bot' });
    expect(res.status).toBe(200);
    const record = res.body as { meta: AgentMeta; spec: AgentSpecV2 };
    expect(record.spec.instructions).toBe('Do the ops.');
    expect(record.meta.enabled).toBe(true);
    expect(record.meta.publishedVersion).toBe(1);
    expect(record.meta.labels).toEqual([]);

    const list = await versions('ops-bot');
    const last = list[0];
    expect(last).toMatchObject({ kind: 'update', source: 'import' });

    // A bundle replace sets the labels; an identical re-import writes no version.
    await doImport({ text: BUNDLE.replace('Bundle Bot', 'Ops Bot'), mode: 'replace', targetId: 'ops-bot' });
    const afterBundle = await repo.readMeta('ops-bot');
    expect(afterBundle.labels).toEqual(['prod', 'ops']);
    const countAfterBundle = (await versions('ops-bot')).length;

    await doImport({ text: BUNDLE.replace('Bundle Bot', 'Ops Bot'), mode: 'replace', targetId: 'ops-bot' });
    expect((await versions('ops-bot')).length).toBe(countAfterBundle);
  });

  it('mode=replace refuses a missing targetId and an unknown agent', async () => {
    const missing = await doImport({ text: V2_JSON, mode: 'replace' });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ error: 'Pick the agent to replace.', code: 'LOUSHO_IMPORT_TARGET_REQUIRED' });

    const unknown = await doImport({ text: V2_JSON, mode: 'replace', targetId: 'ghost' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: "No agent 'ghost'", code: 'LOUSHO_AGENT_NOT_FOUND' });
  });

  it('rejects a bad body and an invalid spec with 400s', async () => {
    const badBody = await doImport({ text: 42, mode: 'new' });
    expect(badBody.status).toBe(400);
    expect(badBody.body.code).toBe('LOUSHO_BODY_INVALID');

    const badSpec = await doImport({ text: '{version:2, name:"x"}', mode: 'new' });
    expect(badSpec.status).toBe(400);
    expect(badSpec.body.code).toBe('LOUSHO_IMPORT_INVALID');
    expect(typeof badSpec.body.error).toBe('string');
  });

  it('POSTs bundle prompts to the observe daemon and ignores failures', async () => {
    const okFetch = recordingFetch();
    vi.stubGlobal('fetch', okFetch);
    const res = await doImport({ text: BUNDLE, mode: 'new' });
    expect(res.status).toBe(201);
    expect(okFetch).toHaveBeenCalledTimes(1);
    const [url, init] = okFetch.mock.calls[0];
    expect(String(url)).toContain('/api/v1/prompts');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'support', text: 'Be nice.' });

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('daemon down'))));
    const failed = await doImport({ text: BUNDLE, mode: 'copy' });
    expect(failed.status).toBe(201);
  });

  it('runImport publishes agent.changed reason import', async () => {
    const events = new StudioEventBus();
    const seen: StudioEvent[] = [];
    events.subscribe((event) => seen.push(event));
    const ws = {
      ref: workspaceRefFor(baseDir),
      repo,
      versions: new VersionStore(repo),
      events,
    } as unknown as WorkspaceContext;
    const record = await runImport({ text: V2_JSON, mode: 'new' }, ws, {
      secrets: new SecretsStore(studioPathsFor(studioHome)),
    });
    expect(record.id).toBe('ops-bot');
    expect(seen).toContainEqual({ type: 'agent.changed', agentId: 'ops-bot', reason: 'import' });
  });
});
