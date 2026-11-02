import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { createApp } from '../app';
import { STUDIO_TOKEN_HEADER } from '../auth';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { SecretsStore } from '../secretsStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import type { AgentStore } from '../../src/persistence/AgentStore';

const TOKEN = 'secret-routes-token-0123456789';
const NAME_ERROR = {
  error: 'Secret names use letters, digits and underscores, and start with a letter or underscore.',
  code: 'LOUSHO_SECRET_NAME_INVALID',
};
const VALUE_ERROR = {
  error: "Request body must include a non-empty 'value' string of at most 16384 characters",
  code: 'LOUSHO_SECRET_VALUE_INVALID',
};

/**
 * The named-secret routes: `GET /settings/secrets`,
 * `GET/PUT/DELETE /settings/secrets/:name` over the app's one
 * Studio-global `SecretsStore` (a global route family - no
 * `workspaceOf`, like the provider-key routes). Responses only ever
 * carry masked `SecretStatus`, never a stored value.
 */
describe('secret routes', () => {
  let baseDir: string;
  let agentStore: AgentStore;
  let runManager: RunManager;
  let secrets: SecretsStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d13-secrets-'));
    agentStore = createFsAgentStore(baseDir);
    const repo = new AgentRepo(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    secrets = new SecretsStore(baseDir);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const app = () => createApp({ agentStore, runManager, baseDir, secretsStore: secrets });
  const gatedApp = () => createApp({ agentStore, runManager, baseDir, secretsStore: secrets, access: { token: TOKEN } });
  const secretsFile = () => path.join(baseDir, '.lousho', 'secrets.json');

  it('GET /settings/secrets lists every named secret sorted by name', async () => {
    secrets.setSecret('SLACK_BOT_TOKEN', 'xoxb-1234');
    secrets.setSecret('GITHUB_TOKEN', 'ghp_5678');
    const res = await request(app()).get('/settings/secrets');
    expect(res.status).toBe(200);
    expect(res.body.map((s: { name: string }) => s.name)).toEqual(['GITHUB_TOKEN', 'SLACK_BOT_TOKEN']);
    for (const s of res.body as { hasValue: boolean; masked: string | null }[]) {
      expect(s.hasValue).toBe(true);
      expect(s.masked).toEqual(expect.any(String));
    }
    expect(JSON.stringify(res.body)).not.toContain('xoxb-1234');
    expect(JSON.stringify(res.body)).not.toContain('ghp_5678');
  });

  it('GET /settings/secrets/:name reports masked status, hasValue: false when unset', async () => {
    secrets.setSecret('GITHUB_TOKEN', 'ghp_abc123');
    const set = await request(app()).get('/settings/secrets/GITHUB_TOKEN');
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ name: 'GITHUB_TOKEN', hasValue: true, masked: '••••••••c123' });
    expect(set.body.updatedAt).toEqual(expect.any(String));
    expect(JSON.stringify(set.body)).not.toContain('ghp_abc123');

    const unset = await request(app()).get('/settings/secrets/NOT_SET');
    expect(unset.status).toBe(200);
    expect(unset.body).toEqual({ name: 'NOT_SET', hasValue: false, masked: null, updatedAt: null });
  });

  it('GET /settings/secrets/:name with a bad name -> 400 LOUSHO_SECRET_NAME_INVALID', async () => {
    const res = await request(app()).get('/settings/secrets/1BAD');
    expect(res.status).toBe(400);
    expect(res.body).toEqual(NAME_ERROR);
  });

  it('PUT /settings/secrets/:name stores the value and answers the masked status', async () => {
    const res = await request(app()).put('/settings/secrets/GITHUB_TOKEN').send({ value: 'ghp_abc123' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'GITHUB_TOKEN', hasValue: true, masked: '••••••••c123' });
    expect(res.body.updatedAt).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toContain('ghp_abc123');
    // The value landed in the store, and never in plaintext on disk.
    expect(secrets.getSecret('GITHUB_TOKEN')).toBe('ghp_abc123');
    expect(fs.readFileSync(secretsFile(), 'utf8')).not.toContain('ghp_abc123');
  });

  it('PUT /settings/secrets/:name with a bad name -> 400 LOUSHO_SECRET_NAME_INVALID', async () => {
    const res = await request(app()).put('/settings/secrets/1BAD').send({ value: 'v' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(NAME_ERROR);
  });

  it.each([
    ['missing', {}],
    ['non-string', { value: 42 }],
    ['empty', { value: '' }],
    ['all whitespace', { value: '   ' }],
    ['too long', { value: 'x'.repeat(16_385) }],
  ])('PUT /settings/secrets/:name with a %s value -> 400 LOUSHO_SECRET_VALUE_INVALID', async (_label, body) => {
    const res = await request(app()).put('/settings/secrets/GITHUB_TOKEN').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(VALUE_ERROR);
    expect(secrets.getSecret('GITHUB_TOKEN')).toBeUndefined();
  });

  it('DELETE /settings/secrets/:name removes it (204); a later GET reports hasValue: false', async () => {
    secrets.setSecret('GITHUB_TOKEN', 'ghp_abc123');
    const del = await request(app()).delete('/settings/secrets/GITHUB_TOKEN');
    expect(del.status).toBe(204);
    expect(secrets.getSecret('GITHUB_TOKEN')).toBeUndefined();
    const get = await request(app()).get('/settings/secrets/GITHUB_TOKEN');
    expect(get.body.hasValue).toBe(false);
    // Deleting an absent secret still 204s.
    expect((await request(app()).delete('/settings/secrets/GITHUB_TOKEN')).status).toBe(204);
  });

  it('DELETE /settings/secrets/:name with a bad name -> 400 LOUSHO_SECRET_NAME_INVALID', async () => {
    const res = await request(app()).delete('/settings/secrets/1BAD');
    expect(res.status).toBe(400);
    expect(res.body).toEqual(NAME_ERROR);
  });

  it('named secrets coexist with provider keys: GET /settings/providers is unchanged', async () => {
    secrets.setKey('openai', 'sk-provider-key');
    secrets.setSecret('GITHUB_TOKEN', 'ghp_abc123');
    const res = await request(app()).get('/settings/providers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { provider: 'openai', hasKey: true, masked: '••••••••-key', envKey: expect.any(Boolean) },
      { provider: 'anthropic', hasKey: false, masked: null, envKey: expect.any(Boolean) },
    ]);
    const secretsList = await request(app()).get('/settings/secrets');
    expect(secretsList.body.map((s: { name: string }) => s.name)).toEqual(['GITHUB_TOKEN']);
  });

  it('every /settings/secrets route needs the studio token', async () => {
    const gated = gatedApp();
    expect((await request(gated).get('/settings/secrets')).status).toBe(401);
    expect((await request(gated).get('/settings/secrets/GITHUB_TOKEN')).status).toBe(401);
    expect((await request(gated).put('/settings/secrets/GITHUB_TOKEN').send({ value: 'x' })).status).toBe(401);
    expect((await request(gated).delete('/settings/secrets/GITHUB_TOKEN')).status).toBe(401);
    // With the token the same routes reach their handlers.
    const ok = await request(gated).get('/settings/secrets').set(STUDIO_TOKEN_HEADER, TOKEN);
    expect(ok.status).toBe(200);
  });
});
