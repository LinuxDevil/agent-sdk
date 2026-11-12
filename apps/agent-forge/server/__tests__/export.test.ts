import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgentSpecV2 } from 'lousho';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { SecretsStore } from '../secretsStore';
import { studioPathsFor } from '../workspace/studioPaths';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import type { AgentBundle } from '../../shared/wireTypes';

const V2_SPEC: AgentSpecV2 = {
  version: 2,
  name: 'ops',
  description: 'Watches the queues.',
  model: 'mock/mock-1',
  instructions: 'Check the queues.',
};

/** Writes a spec file verbatim (bypasses writeSpec's strict parse - pending sections like `evals` stay). */
function writeSpecFile(repo: AgentRepo, id: string, spec: unknown): void {
  fs.mkdirSync(path.dirname(repo.specPath(id)), { recursive: true });
  fs.writeFileSync(repo.specPath(id), stringifyYaml(spec));
}

/** A fetch stub answering the observe daemon's prompt/dataset routes; anything else is a 404. */
function daemonFetch(handlers: Record<string, unknown>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [suffix, body] of Object.entries(handlers)) {
      if (url.includes(suffix)) {
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('GET /agents/:id/export', () => {
  let baseDir: string;
  let studioHome: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l07-export-'));
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

  it('format=yaml downloads the working-copy spec as YAML that round-trips', async () => {
    writeSpecFile(repo, 'ops', V2_SPEC);
    const res = await request(app()).get('/agents/ops/export?format=yaml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/yaml');
    expect(res.headers['content-disposition']).toBe('attachment; filename="ops.yaml"');
    expect(res.text).toContain('# Exported from Lousho Studio');
    const parsed = parseYaml(res.text) as AgentSpecV2;
    expect(parsed).toMatchObject({ version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Check the queues.' });
  });

  it('format=bundle downloads a lousho.agent-bundle with spec, labels, prompt and evals', async () => {
    writeSpecFile(repo, 'ops', {
      ...V2_SPEC,
      promptRef: 'support@prod',
      evals: [{ dataset: 'ds1', minPassRate: 0.9 }],
    });
    await request(app()).patch('/agents/ops/meta').send({ labels: ['prod', 'tier-1'] });
    vi.stubGlobal(
      'fetch',
      daemonFetch({
        '/api/v1/prompts/support/prod': { prompt: { name: 'support', version: 3, text: 'Be nice.' } },
        '/api/v1/datasets/ds1': {
          examples: [
            { input: '{"q":"hi"}', expected: '{"a":"yo"}' },
            { input: { q: 'raw' }, expected: null },
          ],
        },
      })
    );
    const res = await request(app()).get('/agents/ops/export?format=bundle');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toBe('attachment; filename="ops.lousho-agent.json"');
    expect(res.headers['x-lousho-export-warnings']).toBeUndefined();
    const bundle = res.body as AgentBundle;
    expect(bundle.kind).toBe('lousho.agent-bundle');
    expect(bundle.version).toBe(1);
    expect(bundle.spec).toMatchObject({ name: 'ops', promptRef: 'support@prod' });
    expect(bundle.labels).toEqual(['prod', 'tier-1']);
    expect(bundle.prompts).toEqual([{ name: 'support', version: 3, content: 'Be nice.' }]);
    expect(bundle.evals).toEqual([
      {
        dataset: 'ds1',
        examples: [
          { input: { q: 'hi' }, expected: { a: 'yo' } },
          { input: { q: 'raw' }, expected: null },
        ],
      },
    ]);
    expect(typeof bundle.exportedAt).toBe('string');
  });

  it('bundle still downloads with the daemon down, carrying the warnings header', async () => {
    writeSpecFile(repo, 'ops', { ...V2_SPEC, promptRef: 'support@prod' });
    vi.stubGlobal('fetch', daemonFetch({}));
    const res = await request(app()).get('/agents/ops/export?format=bundle');
    expect(res.status).toBe(200);
    const bundle = res.body as AgentBundle;
    expect(bundle.prompts).toEqual([]);
    const warnings = JSON.parse(decodeURIComponent(res.headers['x-lousho-export-warnings'] as string)) as string[];
    expect(warnings).toEqual([
      "Prompt 'support@prod' could not be read from the observe daemon; the bundle uses the inline instructions only.",
    ]);
  });

  it('a failing dataset fetch warns and omits that dataset', async () => {
    writeSpecFile(repo, 'ops', { ...V2_SPEC, evals: [{ dataset: 'missing' }] });
    vi.stubGlobal('fetch', daemonFetch({}));
    const res = await request(app()).get('/agents/ops/export?format=bundle');
    expect(res.status).toBe(200);
    const bundle = res.body as AgentBundle;
    expect(bundle.evals).toBeUndefined();
    const warnings = JSON.parse(decodeURIComponent(res.headers['x-lousho-export-warnings'] as string)) as string[];
    expect(warnings).toContain("Dataset 'missing' could not be read; its examples are not in the bundle.");
  });

  it('a spec without promptRef or evals produces an empty prompts list and no evals key', async () => {
    writeSpecFile(repo, 'ops', V2_SPEC);
    const res = await request(app()).get('/agents/ops/export?format=bundle');
    expect(res.status).toBe(200);
    const bundle = res.body as AgentBundle;
    expect(bundle.prompts).toEqual([]);
    expect('evals' in bundle).toBe(false);
  });

  it('400s on a missing or unknown format and 404s an unknown agent', async () => {
    writeSpecFile(repo, 'ops', V2_SPEC);
    expect((await request(app()).get('/agents/ops/export')).status).toBe(400);
    expect((await request(app()).get('/agents/ops/export?format=json')).status).toBe(400);
    const bad = await request(app()).get('/agents/ops/export?format=json');
    expect(bad.body).toEqual({ error: "format must be 'yaml' or 'bundle'" });
    expect((await request(app()).get('/agents/nope/export?format=yaml')).status).toBe(404);
    const missing = await request(app()).get('/agents/nope/export?format=yaml');
    expect(missing.body).toEqual({ error: "No agent 'nope'" });
  });

  it('never leaks a stored secret value into either export', async () => {
    writeSpecFile(repo, 'ops', {
      ...V2_SPEC,
      mcpServers: { gh: { url: 'https://mcp.example.com', headers: { Authorization: { secret: 'GITHUB_TOKEN' } } } },
    });
    const secrets = new SecretsStore(studioPathsFor(studioHome));
    secrets.setSecret('GITHUB_TOKEN', 'ghp_example');
    const yaml = await request(app()).get('/agents/ops/export?format=yaml');
    expect(yaml.status).toBe(200);
    expect(yaml.text).not.toContain('ghp_example');
    expect(yaml.text).toContain('GITHUB_TOKEN');
    vi.stubGlobal('fetch', daemonFetch({}));
    const bundle = await request(app()).get('/agents/ops/export?format=bundle');
    expect(bundle.status).toBe(200);
    expect(JSON.stringify(bundle.body)).not.toContain('ghp_example');
  });
});
