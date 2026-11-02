/**
 * `GET /agents/:id/requirements` (AA13): the readiness rows of the saved
 * spec v2 - 200 `Requirement[]`, 404 for an unknown id. `GET /agents/:id`
 * carries the same list on `record.requirements` so the detail header and
 * the Author's proposal cards can read it without a second call.
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
import { SecretsStore } from '../secretsStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import type { AgentStore } from '../../src/persistence/AgentStore';
import type { Requirement } from '../../shared/authorWire';

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'needs things',
  model: 'anthropic/claude-x',
  instructions: 'Check the queues.',
  mcpServers: {
    gh: { command: 'gh-mcp', env: { GITHUB_TOKEN: { secret: 'GITHUB_TOKEN' } } },
  },
};

describe('GET /agents/:id/requirements', () => {
  let baseDir: string;
  let agentStore: AgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;
  let secrets: SecretsStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa13-reqs-'));
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
    secrets = new SecretsStore(baseDir);
    // Deterministic env: nothing the spec could resolve leaks in from the host.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const app = () => createApp({ agentStore, runManager, baseDir, secretsStore: secrets });
  const putSpec = (id: string, spec: unknown = SPEC) => request(app()).put(`/agents/${id}`).send({ spec });

  it('answers the spec\'s Requirement[] - missing rows first', async () => {
    expect((await putSpec('ops')).status).toBe(204);
    const res = await request(app()).get('/agents/ops/requirements');
    expect(res.status).toBe(200);
    const rows = res.body as Requirement[];
    const map = new Map(rows.map((row) => [row.id, row]));
    expect(map.get('provider:anthropic')).toMatchObject({
      kind: 'provider_key',
      status: 'missing',
      label: 'Anthropic API key',
      fix: { action: 'open_settings', target: '/settings' },
    });
    expect(map.get('secret:GITHUB_TOKEN')).toMatchObject({
      kind: 'secret',
      status: 'missing',
      fix: { action: 'add_secret', target: 'GITHUB_TOKEN' },
    });
    expect(map.get('mcp:gh')).toMatchObject({
      kind: 'mcp',
      status: 'unknown',
      fix: { action: 'probe', target: 'gh' },
    });
    // No secret value ever appears in the payload.
    expect(JSON.stringify(rows)).not.toContain('ghp_');
  });

  it('marks refs satisfied by the store and the env as ok', async () => {
    secrets.setSecret('GITHUB_TOKEN', 'ghp_route_test');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-route');
    expect((await putSpec('ops')).status).toBe(204);
    const res = await request(app()).get('/agents/ops/requirements');
    const map = new Map((res.body as Requirement[]).map((row) => [row.id, row]));
    expect(map.get('secret:GITHUB_TOKEN')?.status).toBe('ok');
    expect(map.get('provider:anthropic')?.status).toBe('ok');
    expect(JSON.stringify(res.body)).not.toContain('ghp_route_test');
  });

  it('GET /agents/:id carries the same list on record.requirements', async () => {
    expect((await putSpec('ops')).status).toBe(204);
    const res = await request(app()).get('/agents/ops');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.requirements)).toBe(true);
    const map = new Map((res.body.requirements as Requirement[]).map((row) => [row.id, row]));
    expect(map.get('provider:anthropic')?.status).toBe('missing');
    expect(map.get('secret:GITHUB_TOKEN')?.status).toBe('missing');
  });

  it('404 { error: \'Agent not found.\' } for an unknown id', async () => {
    const res = await request(app()).get('/agents/nope/requirements');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Agent not found.' });
  });
});
