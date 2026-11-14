/**
 * L09a portability routes - `POST /agents/:id/portability` and
 * `POST /agents/import/portability` (passes/portabilityRoutes.ts), plus
 * the `adapt=1` export variant (lifecycle/export.ts): the pass's awaited
 * result, its error mapping, the spec-hash caches and the 409 until a
 * check exists.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import request from 'supertest';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { SecretsStore } from '../secretsStore';
import { SettingsStore } from '../settingsStore';
import { studioPathsFor } from '../workspace/studioPaths';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import type { PortabilityAnalysis } from '../../shared/wireTypes';
import { PassUnavailableError } from '../passes/passRunner';

const callPassModel = vi.hoisted(() => vi.fn());
vi.mock('../passes/passModel', () => ({ callPassModel }));

const V2_SPEC: AgentSpecV2 = {
  version: 2,
  name: 'ops',
  model: 'mock/mock-1',
  instructions: 'Ping #ops-alerts when the deploy fails.',
};
const V2_JSON = JSON.stringify(V2_SPEC);

const MODEL_REPLY = {
  summary: 'One hard-wired channel.',
  findings: [
    {
      location: 'instructions',
      kind: 'channel',
      quote: '#ops-alerts',
      explanation: 'Owner channel.',
      suggestion: '[YOUR CHANNEL]',
    },
  ],
  adaptedInstructions: 'Ping [YOUR CHANNEL] when the deploy fails.',
};

describe('portability routes + adapt export', () => {
  let baseDir: string;
  let studioHome: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;
  let settings: SettingsStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l09a-routes-'));
    studioHome = path.join(baseDir, '.lousho');
    agentStore = createFsAgentStore(baseDir);
    repo = new AgentRepo(baseDir);
    settings = new SettingsStore(studioPathsFor(studioHome));
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    callPassModel.mockReset();
    callPassModel.mockResolvedValue(MODEL_REPLY);
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
      settingsStore: settings,
    });
  const writeAgent = async (id = 'ops', spec: AgentSpecV2 = V2_SPEC) => {
    await repo.writeSpec(id, spec);
    const now = new Date().toISOString();
    await repo.writeMeta(id, {
      schemaVersion: 1,
      enabled: true,
      disabledAt: null,
      disabledReason: null,
      failureStreak: 0,
      labels: [],
      createdFrom: { kind: 'blank' },
      publishedVersion: null,
      createdAt: now,
      updatedAt: now,
    });
  };
  const checkAgent = (id: string) => request(app()).post(`/agents/${id}/portability`);
  const checkImport = (body: string | object) => request(app()).post('/agents/import/portability').send(body);
  const exportYaml = (id: string, adapt = false) =>
    request(app()).get(`/agents/${id}/export?format=yaml${adapt ? '&adapt=1' : ''}`);

  it('POST /agents/:id/portability returns the analysis and caches by spec hash', async () => {
    await writeAgent();
    const res = await checkAgent('ops');
    expect(res.status).toBe(200);
    const analysis = res.body as PortabilityAnalysis;
    expect(analysis).toMatchObject({
      kind: 'portability',
      agentId: 'ops',
      summary: MODEL_REPLY.summary,
      findings: MODEL_REPLY.findings,
      adaptedInstructions: MODEL_REPLY.adaptedInstructions,
      model: 'anthropic/claude-haiku-5-5',
    });
    expect(callPassModel).toHaveBeenCalledTimes(1);

    const second = await checkAgent('ops');
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(analysis.id);
    expect(callPassModel).toHaveBeenCalledTimes(1);
  });

  it('404s an unknown agent and 400s a bad import body', async () => {
    expect((await checkAgent('ghost')).status).toBe(404);
    expect((await checkAgent('ghost')).body.code).toBe('LOUSHO_AGENT_NOT_FOUND');

    expect((await checkImport({ text: 42 })).status).toBe(400);
    expect((await checkImport({ text: 42 })).body.code).toBe('LOUSHO_BODY_INVALID');
    expect((await checkImport('not-an-object')).status).toBe(400);
  });

  it('POST /agents/import/portability parses text, checks with agentId null and caches in memory', async () => {
    const res = await checkImport({ text: V2_JSON });
    expect(res.status).toBe(200);
    const analysis = res.body as PortabilityAnalysis;
    expect(analysis.agentId).toBeNull();
    expect(analysis.adaptedInstructions).toBe(MODEL_REPLY.adaptedInstructions);
    expect(callPassModel).toHaveBeenCalledTimes(1);
    expect(callPassModel.mock.calls[0][0].prompt).toContain('Ping #ops-alerts');

    const second = await checkImport({ text: V2_JSON });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(analysis.id);
    expect(callPassModel).toHaveBeenCalledTimes(1);
  });

  it('rejects unparseable import text with the import error codes', async () => {
    const res = await checkImport({ text: '{version:2, name:"x"}' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOUSHO_IMPORT_INVALID');
  });

  it('maps pass outcomes onto the ticket statuses', async () => {
    await writeAgent();
    settings.setPasses({ enabled: { portability_check: false } });
    // A fresh app picks up the disabled pass -> skipped -> 409.
    const skipped = await checkAgent('ops');
    expect(skipped.status).toBe(409);
    expect(skipped.body.code).toBe('LOUSHO_PASS_SKIPPED');

    settings.setPasses({ enabled: { portability_check: true } });
    // PassUnavailableError settles without retry -> fast 503.
    callPassModel.mockRejectedValue(new PassUnavailableError('No API key.'));
    const unavailable = await checkAgent('ops');
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.code).toBe('LOUSHO_PASS_UNAVAILABLE');
  });

  it('adapt=1 export 409s before a check and serves adapted instructions after', async () => {
    await writeAgent();
    const missing = await exportYaml('ops', true);
    expect(missing.status).toBe(409);
    expect(missing.body).toMatchObject({
      error: 'Run the portability check first.',
      code: 'LOUSHO_PORTABILITY_MISSING',
    });

    // A check whose adaptation is null still 409s.
    callPassModel.mockResolvedValue({ ...MODEL_REPLY, adaptedInstructions: null });
    await checkAgent('ops');
    expect((await exportYaml('ops', true)).status).toBe(409);

    // The real adaptation exports with [YOUR …] instructions: a spec edit
    // changes the hash, so the check re-runs for the new spec first.
    await repo.writeSpec('ops', { ...V2_SPEC, description: 'v2' });
    callPassModel.mockResolvedValue(MODEL_REPLY);
    expect((await checkAgent('ops')).status).toBe(200);
    const adapted = await exportYaml('ops', true);
    expect(adapted.status).toBe(200);
    expect(adapted.headers['content-type']).toContain('text/yaml');
    const exported = parseYaml(adapted.text) as AgentSpecV2;
    expect(exported.instructions).toBe(MODEL_REPLY.adaptedInstructions);
    expect(exported.name).toBe('ops');

    // Without adapt=1 the working copy exports unchanged.
    const plain = await exportYaml('ops');
    expect((parseYaml(plain.text) as AgentSpecV2).instructions).toBe(V2_SPEC.instructions);
  });

  it('adapt=1 also applies to the bundle format', async () => {
    await writeAgent();
    await checkAgent('ops');
    const res = await request(app()).get('/agents/ops/export?format=bundle&adapt=1');
    expect(res.status).toBe(200);
    const bundle = res.body as { spec: AgentSpecV2 };
    expect(bundle.spec.instructions).toBe(MODEL_REPLY.adaptedInstructions);
  });
});
