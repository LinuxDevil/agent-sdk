import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { createApp } from '../app';
import { STUDIO_TOKEN_HEADER } from '../auth';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { SecretsStore } from '../secretsStore';
import type { AuthorSettingsPayload } from '../../shared/authorWire';
import type { SettingsFile } from '../../shared/wireTypes';

/**
 * `GET/PUT /settings/author`: the Agent Author's model choices, persisted
 * as a sparse `author` object inside settings.json (profiles untouched),
 * plus `ready`/`missingKeyFor` telling the client whether the configured
 * Author model can run right now.
 */
describe('author settings routes', () => {
  const TOKEN = 'aa02b-test-token';
  let baseDir: string;
  let app: ReturnType<typeof createApp>;

  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'] as const;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa02b-settings-'));
    const agentStore = createFsAgentStore(baseDir);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
    });
    app = createApp({ agentStore, runManager, baseDir, access: { token: TOKEN } });
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const authed = (r: request.Test) => r.set(STUDIO_TOKEN_HEADER, TOKEN);

  function settingsFile(): SettingsFile {
    return JSON.parse(fs.readFileSync(path.join(baseDir, '.lousho', 'settings.json'), 'utf8')) as SettingsFile;
  }

  it('GET returns the defaults with ready: false while the anthropic key is missing', async () => {
    const res = await authed(request(app).get('/settings/author'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      model: 'anthropic/claude-sonnet-5-5',
      reviewModel: 'anthropic/claude-haiku-5-5',
      reviewEnabled: true,
      ready: false,
      missingKeyFor: 'anthropic',
    } satisfies AuthorSettingsPayload);
  });

  it('PUT patches the stored author object, leaves profiles alone, and GET round-trips', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const put = await authed(request(app).put('/settings/author')).send({
      model: 'openai/gpt-4o-mini',
      reviewEnabled: false,
    });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({
      model: 'openai/gpt-4o-mini',
      reviewModel: 'anthropic/claude-haiku-5-5',
      reviewEnabled: false,
      ready: true,
    } satisfies AuthorSettingsPayload);

    const onDisk = settingsFile();
    expect(onDisk.author).toEqual({ model: 'openai/gpt-4o-mini', reviewEnabled: false });
    // The profile bundle is untouched.
    expect(onDisk.profiles.length).toBeGreaterThan(0);
    expect(onDisk.activeProfileId).toBe('local');

    const get = await authed(request(app).get('/settings/author'));
    expect(get.body).toEqual(put.body);
  });

  it('PUT reports ready: true once an anthropic key exists (env or stored)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    const res = await authed(request(app).get('/settings/author'));
    expect(res.body.ready).toBe(true);
    expect(res.body.missingKeyFor).toBeUndefined();
  });

  it('PUT reports ready: true with a stored key even without env vars', async () => {
    new SecretsStore(baseDir).setKey('anthropic', 'sk-stored');
    const res = await authed(request(app).get('/settings/author'));
    expect(res.body.ready).toBe(true);
  });

  it.each([
    { body: { model: 'noslash' }, error: 'model must look like provider/model.' },
    { body: { reviewModel: 'Also Bad' }, error: 'model must look like provider/model.' },
    { body: { reviewEnabled: 'yes' }, error: 'reviewEnabled must be a boolean.' },
  ])('PUT %j -> 400 INVALID_INPUT, nothing stored', async ({ body, error }) => {
    const res = await authed(request(app).put('/settings/author')).send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error, code: 'INVALID_INPUT' });
    expect(fs.existsSync(path.join(baseDir, '.lousho', 'settings.json'))).toBe(false);
  });

  it('a model the Author cannot run reports ready: false with the provider named', async () => {
    const put = await authed(request(app).put('/settings/author')).send({ model: 'mock/x' });
    expect(put.status).toBe(200);
    expect(put.body.ready).toBe(false);
    expect(put.body.missingKeyFor).toBe('mock');
  });
});
